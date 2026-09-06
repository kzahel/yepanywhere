// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  DEFAULT_STEER_NOW_ENABLED,
  PROJECT_QUEUE_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  type ClientDefaults,
} from "@yep-anywhere/shared";
import {
  type ComponentProps,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_TOOLBAR_PRIORITY } from "../../hooks/useSessionToolbarPresence";
import {
  getComposerToolbarOverflowLayoutSignature,
  type ComposerToolbarOverflowLayoutSignatureInput,
} from "../../hooks/useMessageInputToolbarLayout";
import { SESSION_ISEARCH_GUIDE_EVENT } from "../../lib/sessionIsearchGuide";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import type { SpeechCommitOutcome } from "../../lib/speechDraftTransaction";
import { createClientSlashCommand } from "../../lib/slashCommands";
import { UI_KEYS } from "../../lib/storageKeys";
import { createTranscriptPositionStore } from "../../lib/transcriptPositionStore";
import {
  YA_GROK_BATCH_SPEECH_METHOD,
  XAI_DIRECT_STREAMING_SPEECH_METHOD,
} from "../../lib/speechProviders/methods";
import { setBrowserXaiSttApiKey } from "../../lib/speechProviders/xaiCredentials";
import { MessageInput } from "../MessageInput";
import {
  MessageInputToolbarView,
  type MessageInputToolbarViewProps,
} from "../MessageInputToolbar";

const {
  versionState,
  modelSettingsState,
  mockSetThinkingMode,
  mockSetEffortLevel,
  mockSetSpeechMethod,
  mockSetSpeechSmartTurnSettings,
  mockSetGrokSpeechAudioSettings,
  mockVoiceToggle,
  mockVoiceStopAndFinalize,
  mockVoiceCancelProcessing,
  mockVoiceBeginInsertionBoundary,
  mockVoiceContinueAfterSpeechSend,
  voiceButtonState,
  voicePropsState,
  remoteBasePathState,
} = vi.hoisted(() => ({
  versionState: {
    version: {
      current: "test",
      latest: null,
      updateAvailable: false,
      capabilities: [] as string[],
      voiceBackends: [] as string[],
      voiceBackendCapabilities: {} as Record<
        string,
        { streaming?: boolean; smartTurn?: boolean }
      >,
      clientDefaults: undefined as ClientDefaults | undefined,
    },
  },
  modelSettingsState: {
    speechMethod: "browser-native",
    hasStoredSpeechMethod: false,
    speechSmartTurnSettings: {
      enabled: false,
      threshold: 0.95,
      timeoutMs: 3000,
    },
    grokSpeechAudioSettings: {
      uplinkMode: "pcm16" as "pcm16" | "browser-compressed",
    },
  },
  mockSetSpeechMethod: vi.fn(),
  mockSetThinkingMode: vi.fn(),
  mockSetEffortLevel: vi.fn(),
  mockSetSpeechSmartTurnSettings: vi.fn(),
  mockSetGrokSpeechAudioSettings: vi.fn(),
  mockVoiceToggle: vi.fn(),
  mockVoiceStopAndFinalize: vi.fn(() => ""),
  mockVoiceCancelProcessing: vi.fn(),
  mockVoiceBeginInsertionBoundary: vi.fn(),
  mockVoiceContinueAfterSpeechSend: vi.fn(),
  voiceButtonState: {
    isListening: false,
  },
  voicePropsState: {
    current: null as null | {
      onTranscript?: (
        text: string,
        metadata?: {
          smartTurnCommand?: "cancel" | "send" | "wait";
          smartTurnAutoSend?: boolean;
          replacePreviousTranscriptChars?: number;
          speechTargetId?: string;
        },
      ) => SpeechCommitOutcome | undefined;
      onInterimTranscript?: (text: string) => void;
      onListeningStart?: () => void;
      onListeningStop?: () => boolean | undefined;
      onPendingSpeechChange?: (
        kind: "starting" | "listening" | "transcribing" | "finalizing" | null,
        settlement?: "completed" | "failed",
      ) => void;
      onWaveformActiveChange?: (active: boolean) => void;
      onTranscriptionSettled?: (settlement: {
        speechTargetId?: string;
        status: "completed" | "cancelled" | "error";
      }) => void;
      getTranscriptionContext?: () => { speechTargetId?: string };
      showWaveform?: boolean;
      inlineWaveform?: boolean;
    },
  },
  remoteBasePathState: {
    basePath: "",
  },
}));

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: () => {
    const [value, setValueInternal] = useState("");
    const valueRef = useRef("");
    const setValue = useCallback((nextValue: string) => {
      valueRef.current = nextValue;
      setValueInternal(nextValue);
    }, []);
    const getDraft = useCallback(() => valueRef.current, []);
    const setDraft = useCallback((nextValue: string) => {
      valueRef.current = nextValue;
      setValueInternal(nextValue);
    }, []);
    const flushDraft = useCallback(() => {}, []);
    const clearInput = useCallback(() => {
      valueRef.current = "";
      setValueInternal("");
    }, []);
    const clearDraft = useCallback(() => {
      valueRef.current = "";
      setValueInternal("");
    }, []);
    const restoreFromStorage = useCallback(() => {}, []);

    const controls = useMemo(
      () => ({
        getDraft,
        setDraft,
        flushDraft,
        clearInput,
        clearDraft,
        restoreFromStorage,
      }),
      [
        getDraft,
        setDraft,
        flushDraft,
        clearInput,
        clearDraft,
        restoreFromStorage,
      ],
    );

    return [value, setValue, controls] as const;
  },
}));

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    thinkingMode: "off",
    cycleThinkingMode: vi.fn(),
    thinkingLevel: "high",
    setThinkingMode: mockSetThinkingMode,
    setEffortLevel: mockSetEffortLevel,
    voiceInputEnabled: true,
    speechMethod: modelSettingsState.speechMethod,
    hasStoredSpeechMethod: modelSettingsState.hasStoredSpeechMethod,
    setSpeechMethod: mockSetSpeechMethod,
    speechSmartTurnSettings: modelSettingsState.speechSmartTurnSettings,
    setSpeechSmartTurnSettings: mockSetSpeechSmartTurnSettings,
    grokSpeechAudioSettings: modelSettingsState.grokSpeechAudioSettings,
    setGrokSpeechAudioSettings: mockSetGrokSpeechAudioSettings,
  }),
}));

// Toolbar presence is mocked all-visible so control-gating never masks an
// unrelated failure. Tests that care about a specific control's gate flip it
// on this mutable map and restore it in a finally/afterEach.
const toolbarVisibilityOverrides = vi.hoisted(() => ({
  value: {
    modeSelector: true,
    steerNow: true,
    attachments: true,
    slashMenu: true,
    thinkingToggle: true,
    renderMode: true,
    microphone: true,
    waveform: true,
    shortcutsHelp: true,
    contextUsage: true,
    btw: true,
    nudge: true,
    sessionStatus: true,
    projectQueue: true,
    projectQueueNewSessionShortcut: true,
    composerRecall: true,
  },
}));

vi.mock("../../hooks/useSessionToolbarPresence", async () => {
  const actual = await vi.importActual<
    typeof import("../../hooks/useSessionToolbarPresence")
  >("../../hooks/useSessionToolbarPresence");
  return {
    ...actual,
    useSessionToolbarPresence: () => ({
      presence: actual.DEFAULT_SESSION_TOOLBAR_PRIORITY,
      visibility: toolbarVisibilityOverrides.value,
      priority: actual.DEFAULT_SESSION_TOOLBAR_PRIORITY,
      setControlPresence: vi.fn(),
      resetPresence: vi.fn(),
    }),
  };
});

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: versionState.version,
    loading: false,
    error: null,
    refetch: vi.fn(),
    refetchFresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => ({
    providers: [
      {
        name: "claude",
        displayName: "Claude",
        models: [{ id: "test-model", name: "Test Model" }],
      },
    ],
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: {
      clientDefaults: {
        compactAtContextPercent: {},
      },
    },
    isLoading: false,
    error: null,
    updateSettings: vi.fn(),
    updateSetting: vi.fn(async () => undefined),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => remoteBasePathState.basePath,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (
        ({
          commonOr: "or",
          toolbarKeyboardShortcutsAria: "Session keyboard shortcuts",
          toolbarSteerNowLabel: "Steer now",
          toolbarSteerNowShortLabel: "Now",
          toolbarSteerNowTooltip:
            "Steer now interrupts in-flight generation without ending the turn.",
          toolbarOverflowMenu: "More toolbar controls",
          skillInvocationRecognized: "Recognized skill:",
          skillInvocationUnrecognized: "Skill not found:",
          skillInvocationStillSent: "Text will still be sent.",
          toolbarThinkingTitle: `Click to choose thinking mode. Current: ${params?.current ?? ""}`,
          toolbarThinkingAppliesNextTurn: "Applies next turn",
          newSessionThinkingOff: "Thinking off",
          newSessionThinkingAuto: "Thinking auto",
          newSessionThinkingOn: `Thinking on ${params?.level ?? ""}`,
          modelSettingsThinkingOffLabel: "Off",
          modelSettingsThinkingAutoLabel: "Auto",
          modelSettingsThinkingOnLabel: "On",
          effortLevelLowLabel: "Low",
          effortLevelMediumLabel: "Medium",
          effortLevelHighLabel: "High",
          effortLevelMaxLabel: "Max",
          effortLevelExtraHighShortLabel: "XHigh",
          effortLevelLowDescription: "Fastest responses",
          effortLevelMediumDescription: "Moderate reasoning",
          effortLevelHighDescription: "Deep reasoning",
          effortLevelMaxDescription: "Maximum effort",
          toolbarQueuePrimaryActionLabel: "Queue from primary action",
          toolbarQueueShortLabel: "Queue",
          toolbarProjectQueueLabel: "Queue for Project Queue",
          toolbarProjectQueueTooltip:
            "Send after all sessions in this project are idle",
          toolbarProjectQueueTooltipWithShortcut:
            "Send after all sessions in this project are idle\nCtrl+Enter",
          toolbarProjectQueueNewSessionLabel:
            "Queue as new session for Project Queue",
          toolbarProjectQueueNewSessionTooltip:
            "Start a new session after all sessions in this project are idle",
          toolbarLivenessVerifiedProgress: "Verified progress",
          toolbarLivenessVerifiedIdle: "Verified idle",
          toolbarRelativeAgeNow: "now",
          toolbarRelativeAgePast: `${params?.age ?? ""} ago`,
          toolbarLivenessSummary: `${params?.state ?? ""} ${params?.age ?? ""}`,
          toolbarLivenessAria: `Session verified liveness: ${
            params?.summary ?? ""
          }`,
          toolbarLastActivityAria: "Session last activity",
          toolbarLastActivityAge: `Last activity ${params?.age ?? ""}`,
          toolbarPositionAge: `at ${params?.age ?? ""}`,
          toolbarPositionAgeAria: "Transcript position age",
          toolbarBtwChildSessionTitle:
            "Viewing a /btw child session; click to return to Mother (Ctrl+B)",
          toolbarBtwFocusedFooterTitle:
            "Composer is focused on a /btw aside; click to return to Mother (Ctrl+B)",
          toolbarBtwFocusedPaneTitle:
            "A /btw pane is focused; click to focus its composer (Ctrl+B)",
          toolbarBtwFocusExistingTitle: "Focus existing /btw aside (Ctrl+B)",
          toolbarBtwStartTitle: "Start /btw aside (Ctrl+B)",
          toolbarShortcutUserTurns: "User turns",
          toolbarShortcutAllTurns: "All turns",
          toolbarShortcutFullSession: "Full session",
          toolbarShortcutPreviousMatch: "Previous match",
          toolbarShortcutJump: "Jump",
          toolbarShortcutPreviousNextMatch: "Previous / next match",
          toolbarShortcutClick: "Click",
          toolbarShortcutPreviewRailJumps: "Match preview / rail mark jumps",
          toolbarShortcutCancelRestoreFocus: "Cancel / restore focus",
          toolbarShortcutScrollToCurrent: "Scroll to current",
          toolbarShortcutUserTurnReverseSearch: "User-turn reverse search",
          toolbarShortcutAllTurnReverseSearch: "All-turn reverse search",
          toolbarShortcutFullSessionReverseSearch:
            "Full-session reverse search",
          toolbarShortcutSteerCurrentTurn: "Steer current turn",
          toolbarSteerShortLabel: "Steer",
          toolbarShortcutQueueCurrentTurn: "Queue message",
          toolbarShortcutProjectQueue: "Queue for Project Queue",
          toolbarShortcutForkAfterSummary:
            "Fork after initial turn with summary",
          toolbarShortcutSend: "Send",
          toolbarShortcutNewLine: "New line",
          toolbarShortcutRightClickLongPress: "Right-click / long-press ?",
          toolbarShortcutChangeKeys: "Change keys",
          toolbarShortcutSwapEnterCtrlEnter: "Swap Enter and Ctrl+Enter",
          toolbarShortcutStartBtwAside: "Start /btw aside",
          toolbarShortcutStopAgentCancelOverlay: "Stop agent / cancel overlay",
          toolbarShortcutRecallLastSentText: "Recall last sent text",
          toolbarShortcutCancelLatestQueuedMessage:
            "Cancel latest queued message",
          toolbarShortcutClearComposer: "Clear composer",
          toolbarShortcutFullPaneComposer: "Expand / restore composer",
          toolbarShortcutRenderedSourceMode: "Rendered/source mode",
          speechSettingsXaiKeyTitle: "Browser xAI STT Key",
          speechSettingsXaiKeyPlaceholder: "Borrow from server when empty",
          speechListeningPlaceholder: "Listening...",
          speechPrefixDeliveryLabel: `${params?.action ?? ""}. Prepends ${params?.prefix ?? ""}.`,
          speechPrefixDeliveryTooltip: `${params?.tooltip ?? ""} Prepends ${params?.prefix ?? ""}.`,
          speechTranscribingPlaceholder: "Transcribing...",
          speechFinalizingPlaceholder: "Finalizing...",
          speechTranscribingCancel: "Cancel transcription",
          composerFullPaneExpand: "Expand composer",
          composerFullPaneExpandTitle: `Expand composer (${params?.shortcut ?? ""})`,
          composerFullPaneRestore: "Restore composer",
          composerFullPaneRestoreTitle: `Restore composer (${params?.shortcut ?? ""})`,
          messageInputCollapsedLineCount: `${params?.count ?? ""} lines`,
          forkSummaryComposerTitle: "Fork after selected turn",
          forkSummaryComposerDescription:
            "Keep this request and the agent response to it; replace later turns with a generated summary.",
          forkSummaryComposerPlaceholder:
            "Optional summary instructions; leave empty for the default summary...",
          forkSummarySubmit: "Fork with summary",
          forkSummaryTooltip:
            "Fork after the selected turn with a generated summary",
          forkSummaryCancel: "Cancel fork summary",
        }) satisfies Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../VoiceInputButton", async () => {
  const React = await import("react");

  return {
    VoiceInputButton: React.forwardRef(
      (
        props: {
          onTranscript?: (
            text: string,
            metadata?: {
              smartTurnCommand?: "cancel" | "send" | "wait";
              smartTurnAutoSend?: boolean;
              replacePreviousTranscriptChars?: number;
              speechTargetId?: string;
            },
          ) => SpeechCommitOutcome | undefined;
          onInterimTranscript?: (text: string) => void;
          onListeningStart?: () => void;
          onListeningStop?: () => boolean | undefined;
          onPendingSpeechChange?: (
            kind:
              | "starting"
              | "listening"
              | "transcribing"
              | "finalizing"
              | null,
            settlement?: "completed" | "failed",
          ) => void;
          onWaveformActiveChange?: (active: boolean) => void;
          getTranscriptionContext?: () => { speechTargetId?: string };
          speechMethod?: string | null;
          showWaveform?: boolean;
          inlineWaveform?: boolean;
          className?: string;
        },
        ref,
      ) => {
        voicePropsState.current = props;
        React.useImperativeHandle(ref, () => ({
          stopAndFinalize: mockVoiceStopAndFinalize,
          toggle: mockVoiceToggle,
          cancelProcessing: mockVoiceCancelProcessing,
          prewarm: vi.fn(),
          beginInsertionBoundary: mockVoiceBeginInsertionBoundary,
          continueAfterSpeechSend: mockVoiceContinueAfterSpeechSend,
          isAvailable: true,
          isListening: voiceButtonState.isListening,
        }));

        return (
          <button
            type="button"
            className={`voice-input-button ${props.className ?? ""}`.trim()}
            data-speech-method={props.speechMethod}
            onClick={() => {
              props.onListeningStart?.();
              mockVoiceToggle();
            }}
          >
            voice
          </button>
        );
      },
    ),
  };
});

function installDesktopMatchMedia() {
  const previous = Object.getOwnPropertyDescriptor(window, "matchMedia");

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  return () => {
    if (previous) {
      Object.defineProperty(window, "matchMedia", previous);
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
  };
}

function installMobileKeyboardViewport(initialHeight = 800) {
  const previousMatchMedia = Object.getOwnPropertyDescriptor(
    window,
    "matchMedia",
  );
  const previousVisualViewport = Object.getOwnPropertyDescriptor(
    window,
    "visualViewport",
  );
  const restoreInnerHeight = installWindowNumberProperty(
    "innerHeight",
    initialHeight,
  );
  let height = initialHeight;
  const visualViewport = new EventTarget();
  Object.defineProperty(visualViewport, "height", {
    configurable: true,
    get: () => height,
  });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: visualViewport,
  });

  return {
    setHeight(nextHeight: number) {
      height = nextHeight;
      visualViewport.dispatchEvent(new Event("resize"));
    },
    restore() {
      restoreInnerHeight();
      if (previousMatchMedia) {
        Object.defineProperty(window, "matchMedia", previousMatchMedia);
      } else {
        Reflect.deleteProperty(window, "matchMedia");
      }
      if (previousVisualViewport) {
        Object.defineProperty(window, "visualViewport", previousVisualViewport);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    },
  };
}

function installWindowNumberProperty(key: "innerHeight", value: number) {
  const previous = Object.getOwnPropertyDescriptor(window, key);

  Object.defineProperty(window, key, {
    configurable: true,
    value,
  });

  return () => {
    if (previous) {
      Object.defineProperty(window, key, previous);
    } else {
      Reflect.deleteProperty(window, key);
    }
  };
}

function renderMessageInput(
  onRecallLastSubmission = vi.fn(() => true),
  extraProps: Partial<ComponentProps<typeof MessageInput>> = {},
) {
  const placeholder = extraProps.placeholder ?? "Message";
  render(
    <MessageInput
      onSend={vi.fn()}
      draftKey="test-draft"
      placeholder={placeholder}
      supportsPermissionMode={false}
      supportsThinkingToggle={false}
      onRecallLastSubmission={onRecallLastSubmission}
      {...extraProps}
    />,
  );

  return screen.getByPlaceholderText(
    extraProps.collapsed
      ? "messageInputContinueAbove"
      : extraProps.forkSummaryMode
        ? extraProps.forkSummaryMode.placeholder
        : placeholder,
  );
}

function expectSubmission(
  fn: { mock: { calls: unknown[][] } },
  text: string,
  deliveryIntent: string,
) {
  const call = fn.mock.calls.at(-1);
  expect(call?.[0]).toBe(text);
  expect(call?.[1]).toMatchObject({
    deliveryIntent,
    composition: {
      typingStartedAt: expect.any(String),
      typingEndedAt: expect.any(String),
      lastEditedAt: expect.any(String),
      submittedAt: expect.any(String),
    },
  });
}

const TEST_ATTACHMENT = {
  id: "attachment-1",
  originalName: "notes.txt",
  path: "/workspace/notes.txt",
  mimeType: "text/plain",
  size: 5,
};

const toolbarVisibility: MessageInputToolbarViewProps["visibility"] = {
  modeSelector: false,
  steerNow: true,
  attachments: false,
  slashMenu: false,
  thinkingToggle: true,
  renderMode: false,
  conversationView: false,
  browserDebug: false,
  microphone: false,
  waveform: false,
  shortcutsHelp: false,
  contextUsage: false,
  btw: false,
  nudge: false,
  syntheticDone: false,
  sessionStatus: false,
  projectQueue: false,
  projectQueueNewSessionShortcut: false,
  composerRecall: false,
};

const toolbarT = ((key: string, params?: Record<string, string>) => {
  const translations: Record<string, string> = {
    modelSettingsEffortTitle: "Effort Level",
    modelSettingsThinkingAutoLabel: "Auto",
    modelSettingsThinkingOffLabel: "Off",
    modelSettingsThinkingOnLabel: "On",
    modelSettingsThinkingTitle: "Thinking Mode",
    newSessionThinkingAuto: "Thinking: auto",
    newSessionThinkingOff: "Thinking: off",
    newSessionThinkingOn: `Thinking: on (${params?.level ?? ""})`,
    toolbarThinkingTitle: `${params?.current ?? ""}. Click to choose; right-click or long-press to toggle off/on. Applies next turn.`,
    toolbarKeyboardShortcutsAria: "Session keyboard shortcuts",
    toolbarQueueLabel: "Queue message",
    toolbarQueueTooltip: "Queue for the next regular delivery\nCtrl+Enter",
    toolbarProjectQueueLabel: "Queue for Project Queue",
    toolbarProjectQueueTooltip:
      "Send after all sessions in this project are idle",
    toolbarProjectQueueTooltipWithShortcut:
      "Send after all sessions in this project are idle\nCtrl+Enter",
    toolbarProjectQueueNewSessionLabel:
      "Queue as new session for Project Queue",
    toolbarProjectQueueNewSessionTooltip:
      "Start a new session after all sessions in this project are idle",
    toolbarSteerNowLabel: "Steer now",
    toolbarSteerNowShortLabel: "Now",
    toolbarSteerNowTooltip: "Steer current turn now",
    toolbarSteerTooltip: "Steer current turn\nEnter",
    toolbarSend: "Send",
    toolbarOverflowMenu: "More toolbar controls",
    toolbarBrowserDebugMenu: "Browser debugging actions",
    toolbarBrowserDebugDismissMenu: "Dismiss browser debugging actions",
    toolbarBrowserDebugReload: "Reload app code (keep debugging)",
    toolbarBrowserDebugReactivate: "Reconnect existing debug link",
    toolbarBrowserDebugDisableNow: "Disable browser debugging",
    toolbarRelativeAgeNow: "now",
    toolbarRelativeAgePast: `${params?.age ?? ""} ago`,
    toolbarPositionAge: `at ${params?.age ?? ""}`,
    toolbarPositionAgeAria: "Transcript position age",
    toolbarLastActivityAria: "Session last activity",
    toolbarLastActivityAge: `Last activity ${params?.age ?? ""}`,
    toolbarProviderRuntimeAria: `Provider runtime status: ${
      params?.summary ?? ""
    }`,
    fileViewerController: `File viewer: ${params?.name ?? ""}`,
    fileViewerMinimizeNamed: `Minimize file viewer: ${params?.name ?? ""}`,
    fileViewerRestore: `Restore file viewer: ${params?.name ?? ""}`,
    fileViewerClose: `Close file viewer: ${params?.name ?? ""}`,
    sessionViewerController: `Detail view: ${params?.name ?? ""}`,
    sessionViewerMinimizeNamed: `Minimize detail view: ${params?.name ?? ""}`,
    sessionViewerRestore: `Restore detail view: ${params?.name ?? ""}`,
    sessionViewerClose: `Close detail view: ${params?.name ?? ""}`,
  };
  return translations[key] ?? key;
}) as MessageInputToolbarViewProps["t"];

function renderToolbarView(
  thinkingControl: Omit<
    NonNullable<MessageInputToolbarViewProps["thinkingControl"]>,
    "showThinking" | "onSetShowThinking"
  >,
) {
  const control: NonNullable<MessageInputToolbarViewProps["thinkingControl"]> =
    {
      showThinking: "default",
      onSetShowThinking: () => {},
      ...thinkingControl,
    };
  render(
    <MessageInputToolbarView
      t={toolbarT}
      visibility={toolbarVisibility}
      attachmentControl={{ attachmentCount: 0 }}
      thinkingControl={control}
      shortcutsControl={{
        open: false,
        isearchScope: null,
        setOpen:
          vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
        settingsOpen: false,
        setSettingsOpen:
          vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
        hasDualActions: false,
        enterActionKind: "send",
        canSwapEnterAction: false,
        queueShortcutLabel: "Queue while agent runs",
      }}
      actionsControl={{}}
    />,
  );
}

describe("MessageInput", () => {
  let restoreDefaultMatchMedia: () => void;

  beforeEach(() => {
    restoreDefaultMatchMedia = installDesktopMatchMedia();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    versionState.version = {
      current: "test",
      latest: null,
      updateAvailable: false,
      capabilities: [VOICE_INPUT_CAPABILITY, PROJECT_QUEUE_CAPABILITY],
      voiceBackends: [],
      voiceBackendCapabilities: {},
      clientDefaults: undefined,
    };
    modelSettingsState.speechMethod = "browser-native";
    modelSettingsState.hasStoredSpeechMethod = false;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: false,
      threshold: 0.95,
      timeoutMs: 3000,
    };
    modelSettingsState.grokSpeechAudioSettings = {
      uplinkMode: "pcm16",
    };
    remoteBasePathState.basePath = "";
    mockSetSpeechMethod.mockReset();
    mockSetThinkingMode.mockReset();
    mockSetEffortLevel.mockReset();
    mockSetSpeechSmartTurnSettings.mockReset();
    mockSetGrokSpeechAudioSettings.mockReset();
    mockVoiceToggle.mockReset();
    mockVoiceStopAndFinalize.mockReset();
    mockVoiceCancelProcessing.mockReset();
    mockVoiceBeginInsertionBoundary.mockReset();
    mockVoiceContinueAfterSpeechSend.mockReset();
    voiceButtonState.isListening = false;
    voicePropsState.current = null;
    window.localStorage.clear();
    window.localStorage.setItem(UI_KEYS.tooltipMode, "themed");
    window.localStorage.setItem(UI_KEYS.speechMessagePrefixMode, "asr");
    invalidateLocalStorageValues(UI_KEYS.keepMobileKeyboardOpenAfterDelivery);
  });

  afterEach(() => {
    cleanup();
    restoreDefaultMatchMedia();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("grows the expanded composer until the draft reaches half the viewport", () => {
    const restoreInnerHeight = installWindowNumberProperty("innerHeight", 400);
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    let scrollHeight = 160;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    try {
      fireEvent.change(textarea, {
        target: { value: "one\ntwo\nthree\nfour" },
      });

      expect(textarea.style.height).toBe("160px");
      expect(textarea.style.overflowY).toBe("hidden");

      scrollHeight = 260;
      fireEvent.change(textarea, {
        target: { value: "one\ntwo\nthree\nfour\nfive\nsix\nseven" },
      });

      expect(textarea.style.height).toBe("200px");
      expect(textarea.style.overflowY).toBe("auto");
    } finally {
      restoreInnerHeight();
    }
  });

  it("keeps the normal toolbar while empty and uses compact actions for content", () => {
    const viewport = installMobileKeyboardViewport();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onSend },
    );

    try {
      expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
      expect(document.querySelector(".message-input-toolbar")).toBeTruthy();

      fireEvent.focus(textarea);
      act(() => viewport.setHeight(480));

      expect(document.querySelector(".message-input-toolbar")).toBeTruthy();
      expect(
        document.querySelector(".message-input-keyboard-compact"),
      ).toBeNull();
      expect(
        document.querySelector(".message-input-keyboard-primary"),
      ).toBeNull();

      fireEvent.change(textarea, { target: { value: "mobile send" } });
      const keyboardAction = document.querySelector(
        ".message-input-keyboard-primary",
      ) as HTMLButtonElement | null;
      expect(keyboardAction).toBeTruthy();
      expect(keyboardAction?.textContent).toContain("toolbarSend");
      expect(
        document.querySelector(".message-input-keyboard-more"),
      ).toBeTruthy();
      expect(document.querySelector(".message-input-toolbar")).toBeNull();

      fireEvent.pointerDown(keyboardAction as HTMLButtonElement);
      fireEvent.click(keyboardAction as HTMLButtonElement);

      expectSubmission(onSend, "mobile send", "direct");
      expect(document.activeElement).not.toBe(textarea);
      expect(
        document.querySelector(".message-input-keyboard-primary"),
      ).toBeNull();
      expect(document.querySelector(".message-input-keyboard-more")).toBeNull();
      expect(document.querySelector(".message-input-toolbar")).toBeTruthy();

      act(() => viewport.setHeight(800));
      expect(
        document.querySelector(".message-input-keyboard-primary"),
      ).toBeNull();
      expect(document.querySelector(".message-input-toolbar")).toBeTruthy();
    } finally {
      viewport.restore();
    }
  });

  it("retires a Gboard composition when the mobile action delivers", () => {
    const viewport = installMobileKeyboardViewport();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onSend },
    ) as HTMLTextAreaElement;

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(textarea, {
        target: { value: "We need to do something smarter" },
      });
      fireEvent.compositionStart(textarea);

      const keyboardAction = document.querySelector(
        ".message-input-keyboard-primary",
      ) as HTMLButtonElement;
      fireEvent.pointerDown(keyboardAction);
      fireEvent.click(keyboardAction);

      expectSubmission(onSend, "We need to do something smarter", "direct");
      const replacement = screen.getByPlaceholderText(
        "Message",
      ) as HTMLTextAreaElement;
      expect(replacement).not.toBe(textarea);
      expect(replacement.value).toBe("");
      expect(document.activeElement).not.toBe(replacement);

      // Gboard may commit its final composing region after the controlled
      // draft was cleared. That event belongs to the retired editing host.
      fireEvent.change(textarea, {
        target: { value: "do something smarter" },
      });
      fireEvent.compositionEnd(textarea);
      expect(replacement.value).toBe("");
      expect(onSend).toHaveBeenCalledTimes(1);

      fireEvent.change(replacement, { target: { value: "Fresh next turn" } });
      expect(replacement.value).toBe("Fresh next turn");
    } finally {
      viewport.restore();
    }
  });

  it("refocuses a fresh mobile editing host when retention is enabled", async () => {
    window.localStorage.setItem(
      UI_KEYS.keepMobileKeyboardOpenAfterDelivery,
      "true",
    );
    invalidateLocalStorageValues(UI_KEYS.keepMobileKeyboardOpenAfterDelivery);
    const viewport = installMobileKeyboardViewport();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onSend },
    ) as HTMLTextAreaElement;

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(textarea, { target: { value: "Keep composing" } });

      fireEvent.click(
        document.querySelector(
          ".message-input-keyboard-primary",
        ) as HTMLButtonElement,
      );

      expectSubmission(onSend, "Keep composing", "direct");
      const replacement = screen.getByPlaceholderText(
        "Message",
      ) as HTMLTextAreaElement;
      expect(replacement).not.toBe(textarea);
      await waitFor(() => expect(document.activeElement).toBe(replacement));
    } finally {
      viewport.restore();
    }
  });

  it("restores compact actions after keyboard voice transcription", () => {
    const viewport = installMobileKeyboardViewport();
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    try {
      fireEvent.focus(textarea);
      act(() => viewport.setHeight(480));
      expect(
        document.querySelector(".message-input-keyboard-compact"),
      ).toBeNull();

      act(() => viewport.setHeight(800));
      fireEvent.change(textarea, {
        target: { value: "keyboard voice transcript" },
      });
      expect(
        document.querySelector(".message-input-keyboard-compact"),
      ).toBeNull();

      act(() => viewport.setHeight(480));
      expect(
        document.querySelector(".message-input-keyboard-primary"),
      ).toBeTruthy();
      expect(document.querySelector(".message-input-toolbar")).toBeNull();
    } finally {
      viewport.restore();
    }
  });

  it("shows the alternate beside the primary mobile keyboard action", async () => {
    const viewport = installMobileKeyboardViewport();
    versionState.version = {
      ...versionState.version,
      clientDefaults: {
        busyComposerDefaultAction: "steer",
        patientQueueDefault: true,
      },
    };
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        onQueue,
        supportsSteering: true,
      },
    );

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(textarea, { target: { value: "wait until done" } });

      const actions = document.querySelectorAll(
        ".message-input-keyboard-action",
      );
      expect(actions).toHaveLength(3);
      expect(actions[0]?.classList.contains("voice-input-button")).toBe(true);
      expect(actions[0]?.textContent).toBe("voice");
      expect(actions[1]?.classList.contains("queue-mode")).toBe(true);
      expect(actions[1]?.getAttribute("aria-label")).toBe("toolbarQueueLabel");
      expect(actions[1]?.textContent).toBe("→");
      expect(actions[2]?.classList.contains("steer-mode")).toBe(true);
      expect(actions[2]?.getAttribute("aria-label")).toBe("Steer current turn");
      expect(
        actions[2]?.querySelector(".message-input-keyboard-primary-label")
          ?.textContent,
      ).toBe("Steer");
      expect(actions[2]?.textContent).toBe("Steer↗");

      fireEvent.click(actions[1] as HTMLButtonElement);
      expectSubmission(onQueue, "wait until done", "patient");
      await act(
        () => new Promise<void>((resolve) => window.setTimeout(resolve, 20)),
      );

      const nextTextarea = screen.getByPlaceholderText(
        "Message",
      ) as HTMLTextAreaElement;
      act(() => viewport.setHeight(800));
      act(() => nextTextarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(nextTextarea, { target: { value: "steer now" } });
      fireEvent.click(
        document.querySelector(
          ".message-input-keyboard-primary",
        ) as HTMLButtonElement,
      );
      expectSubmission(onSend, "steer now", "steer");
    } finally {
      viewport.restore();
    }
  });

  it("preallocates the keyboard waveform inside the microphone control", () => {
    const viewport = installMobileKeyboardViewport();
    const textarea = renderMessageInput();

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(textarea, { target: { value: "steer with speech" } });

      expect(voicePropsState.current?.showWaveform).toBe(true);
      expect(voicePropsState.current?.inlineWaveform).toBe(true);

      const speechSlot = document.querySelector(
        ".message-input-keyboard-secondary-slot",
      );
      expect(speechSlot?.getAttribute("data-waveform-reserved")).toBe("true");
      expect(speechSlot?.getAttribute("data-waveform-active")).toBeNull();

      act(() => voicePropsState.current?.onWaveformActiveChange?.(true));

      expect(
        document.querySelector(".message-input-keyboard-secondary-slot"),
      ).toBe(speechSlot);
      expect(speechSlot?.getAttribute("data-waveform-active")).toBe("true");
      expect(speechSlot?.querySelector(".voice-input-button")).toBeTruthy();
    } finally {
      viewport.restore();
    }
  });

  it("keeps the keyboard-open row free of disabled actions after send starts a turn", () => {
    const viewport = installMobileKeyboardViewport();
    const onSend = vi.fn();
    const onQueue = vi.fn();

    function BusyAfterSendHarness() {
      const [busy, setBusy] = useState(false);
      return (
        <MessageInput
          onSend={(text, metadata) => {
            onSend(text, metadata);
            setBusy(true);
          }}
          onQueue={busy ? onQueue : undefined}
          supportsSteering={busy}
          primaryActionKind={busy ? "steer" : "send"}
          draftKey="keyboard-transition-draft"
          placeholder="Message"
          supportsPermissionMode={false}
          supportsThinkingToggle={false}
        />
      );
    }

    render(<BusyAfterSendHarness />);
    const textarea = screen.getByPlaceholderText("Message");

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(textarea, { target: { value: "start the turn" } });
      fireEvent.click(
        document.querySelector(
          ".message-input-keyboard-primary",
        ) as HTMLButtonElement,
      );

      expectSubmission(onSend, "start the turn", "direct");
      expect(
        document.querySelectorAll(".message-input-keyboard-action"),
      ).toHaveLength(0);
      expect(document.querySelector(".message-input-keyboard-more")).toBeNull();
      expect(document.querySelector(".message-input-toolbar")).toBeTruthy();
    } finally {
      viewport.restore();
    }
  });

  it("keeps keyboard focus while More exposes utilities and Project Queue stays inline", () => {
    const viewport = installMobileKeyboardViewport();
    const onProjectQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();
    const onAttach = vi.fn();
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onProjectQueue,
        onProjectQueueNewSession,
        onAttach,
        projectId: "project-1",
        sessionId: "session-1",
      },
    );

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));

      expect(document.querySelector(".message-input-toolbar")).toBeTruthy();
      fireEvent.change(textarea, { target: { value: "project later" } });

      const more = screen.getByRole("button", {
        name: "More toolbar controls",
      });
      fireEvent.pointerDown(more);
      fireEvent.click(more);

      expect(more.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(textarea);
      const morePanel = document.querySelector(
        ".message-input-keyboard-more-panel",
      );
      expect(
        morePanel?.querySelector('[aria-label="Queue for Project Queue"]'),
      ).toBeNull();
      expect(
        morePanel?.querySelector(
          '[aria-label="Queue as new session for Project Queue"]',
        ),
      ).toBeNull();

      const attach = screen.getByTitle("toolbarAttachFiles");
      fireEvent.pointerDown(attach);
      fireEvent.click(attach);
      expect(inputClick).toHaveBeenCalledTimes(1);

      fireEvent.pointerDown(more);
      fireEvent.click(more);
      expect(more.getAttribute("aria-expanded")).toBe("false");

      expect(
        document.querySelector(
          ".message-input-keyboard-project-queue-slot .project-queue-mode",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector(
          ".message-input-keyboard-project-queue-new-session-slot .project-queue-new-session-button",
        ),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Queue for Project Queue" }),
      );
      expectSubmission(onProjectQueue, "project later", "deferred");
    } finally {
      viewport.restore();
    }
  });

  it("lets visible actions absorb unavailable session-action space", () => {
    const viewport = installMobileKeyboardViewport();
    const onQueue = vi.fn();
    const onProjectQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();

    function LiveActionsHarness() {
      const [actionsAvailable, setActionsAvailable] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setActionsAvailable(true)}>
            Make queue actions available
          </button>
          <MessageInput
            onSend={vi.fn()}
            onQueue={actionsAvailable ? onQueue : undefined}
            onProjectQueue={actionsAvailable ? onProjectQueue : undefined}
            onProjectQueueNewSession={onProjectQueueNewSession}
            supportsSteering
            draftKey="stable-mobile-actions"
            placeholder="Stable actions"
            supportsPermissionMode={false}
            supportsThinkingToggle={false}
          />
        </>
      );
    }

    render(<LiveActionsHarness />);
    const textarea = screen.getByPlaceholderText("Stable actions");

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(textarea, { target: { value: "queue this later" } });

      const projectQueueNewSessionSlot = document.querySelector(
        ".message-input-keyboard-project-queue-new-session-slot",
      );

      expect(
        document.querySelector(".message-input-keyboard-project-queue-slot"),
      ).toBeNull();
      expect(projectQueueNewSessionSlot).toBeTruthy();
      expect(
        document.querySelector(
          ".message-input-keyboard-session-alternate-slot",
        ),
      ).toBeNull();
      expect(
        projectQueueNewSessionSlot?.querySelector(
          ".project-queue-new-session-button",
        ),
      ).toBeTruthy();

      fireEvent.click(
        screen.getByRole("button", {
          name: "Make queue actions available",
        }),
      );

      expect(
        document.querySelector(
          ".message-input-keyboard-project-queue-slot .project-queue-mode",
        ),
      ).toBeTruthy();
      expect(
        document.querySelector(
          ".message-input-keyboard-session-alternate-slot .queue-mode",
        ),
      ).toBeTruthy();
    } finally {
      viewport.restore();
    }
  });

  it("does not reserve Project Queue slots against an unsupported server", () => {
    const viewport = installMobileKeyboardViewport();
    versionState.version = {
      ...versionState.version,
      capabilities: [],
    };
    const textarea = renderMessageInput();

    try {
      act(() => textarea.focus());
      act(() => viewport.setHeight(480));
      fireEvent.change(textarea, { target: { value: "send normally" } });

      expect(
        document.querySelector(".message-input-keyboard-project-queue-slot"),
      ).toBeNull();
      expect(
        document.querySelector(
          ".message-input-keyboard-project-queue-new-session-slot",
        ),
      ).toBeNull();
    } finally {
      viewport.restore();
    }
  });

  it("uses fork summary mode with empty instructions as a valid submit", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderMessageInput(vi.fn(), {
      forkSummaryMode: {
        title: "Fork after selected turn",
        description:
          "Keep this request and the agent response to it; replace later turns with a generated summary.",
        placeholder:
          "Optional summary instructions; leave empty for the default summary...",
        submitLabel: "Fork with summary",
        tooltip: "Fork after the selected turn with a generated summary",
        icon: "⑂",
        onCancel,
        onSubmit,
      },
    });

    expect(screen.getByText("Fork after selected turn")).toBeTruthy();
    expect(
      screen.getByPlaceholderText(
        "Optional summary instructions; leave empty for the default summary...",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fork with summary" }));

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("uses Ctrl+Enter for fork-after without summary while in fork mode", () => {
    const onSubmit = vi.fn();
    const onSubmitWithoutSummary = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      forkSummaryMode: {
        title: "Fork after selected turn",
        description:
          "Keep this request and the agent response to it; replace later turns with a generated summary.",
        placeholder:
          "Optional summary instructions; leave empty for the default summary...",
        submitLabel: "Fork with summary",
        tooltip: "Fork after the selected turn with a generated summary",
        icon: "⑂",
        noSummarySubmitLabel: "Fork without summary",
        noSummaryTooltip: "Fork after without summary",
        noSummaryIcon: "↱",
        onCancel: vi.fn(),
        onSubmit,
        onSubmitWithoutSummary,
      },
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "  branch text  " } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onSubmitWithoutSummary).toHaveBeenCalledWith("  branch text  ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("dispatches a command-only speech fork-summary as a typed action", async () => {
    const onSend = vi.fn();
    const onSubmit = vi.fn();
    renderMessageInput(vi.fn(), {
      onSend,
      forkSummaryMode: {
        title: "Fork after selected turn",
        description: "Generate a summary before forking.",
        placeholder: "Optional summary instructions",
        submitLabel: "Fork with summary",
        tooltip: "Fork with generated summary",
        icon: "⑂",
        onCancel: vi.fn(),
        onSubmit,
      },
    });

    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
      });
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("reports an ineligible command-only speech fork as unhandled", () => {
    const onSubmit = vi.fn();
    renderMessageInput(vi.fn(), {
      disabled: true,
      forkSummaryMode: {
        title: "Fork after selected turn",
        description: "Generate a summary before forking.",
        placeholder: "Optional summary instructions",
        submitLabel: "Fork with summary",
        tooltip: "Fork with generated summary",
        icon: "⑂",
        onCancel: vi.fn(),
        onSubmit,
      },
    });

    let outcome: SpeechCommitOutcome | undefined;
    act(() => {
      outcome = voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
      });
    });

    expect(outcome).toBe("send-unhandled");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(mockVoiceContinueAfterSpeechSend).not.toHaveBeenCalled();
  });

  it("settles a no-summary speech fork exactly once", async () => {
    const onSubmitWithoutSummary = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      forkSummaryMode: {
        title: "Fork after selected turn",
        description: "Fork without retaining later turns.",
        placeholder: "Optional summary instructions",
        submitLabel: "Fork with summary",
        tooltip: "Fork with generated summary",
        icon: "⑂",
        noSummarySubmitLabel: "Fork without summary",
        onCancel: vi.fn(),
        onSubmit: vi.fn(),
        onSubmitWithoutSummary,
      },
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "branch " } });
    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("provisional");
    });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onSubmitWithoutSummary).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");

    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    await waitFor(() =>
      expect(onSubmitWithoutSummary).toHaveBeenCalledWith("branch provisional"),
    );
    expect(onSubmitWithoutSummary).toHaveBeenCalledOnce();
  });

  it("restores a failed no-summary speech fork without dispatching", () => {
    const onSubmitWithoutSummary = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      forkSummaryMode: {
        title: "Fork after selected turn",
        description: "Fork without retaining later turns.",
        placeholder: "Optional summary instructions",
        submitLabel: "Fork with summary",
        tooltip: "Fork with generated summary",
        icon: "⑂",
        noSummarySubmitLabel: "Fork without summary",
        onCancel: vi.fn(),
        onSubmit: vi.fn(),
        onSubmitWithoutSummary,
      },
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "branch draft" } });
    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onPendingSpeechChange?.(null, "failed");
    });

    expect(onSubmitWithoutSummary).not.toHaveBeenCalled();
    expect(textarea.value).toBe("branch draft");
  });

  it("does not detach pending speech for an ineligible fork", () => {
    const onSubmitWithoutSummary = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      disabled: true,
      forkSummaryMode: {
        title: "Fork after selected turn",
        description: "Fork without retaining later turns.",
        placeholder: "Optional summary instructions",
        submitLabel: "Fork with summary",
        tooltip: "Fork with generated summary",
        icon: "⑂",
        noSummarySubmitLabel: "Fork without summary",
        onCancel: vi.fn(),
        onSubmit: vi.fn(),
        onSubmitWithoutSummary,
      },
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "keep this draft" } });
    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(mockVoiceStopAndFinalize).not.toHaveBeenCalled();
    expect(onSubmitWithoutSummary).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep this draft");
  });

  it("restores a deferred summary fork rejected at settlement", () => {
    const onSubmit = vi.fn();
    const forkSummaryMode = {
      title: "Fork after selected turn",
      description: "Generate a summary before forking.",
      placeholder: "Optional summary instructions",
      submitLabel: "Fork with summary",
      tooltip: "Fork with generated summary",
      icon: "⑂",
      onCancel: vi.fn(),
      onSubmit,
    };
    const view = (disabled: boolean) => (
      <MessageInput
        onSend={vi.fn()}
        draftKey="test-draft"
        placeholder="Message"
        supportsPermissionMode={false}
        supportsThinkingToggle={false}
        disabled={disabled}
        forkSummaryMode={forkSummaryMode}
      />
    );
    const { rerender } = render(view(false));
    const textarea = screen.getByPlaceholderText(
      "Optional summary instructions",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "keep summary draft" } });
    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    fireEvent.click(screen.getByRole("button", { name: "Fork with summary" }));
    expect(textarea.value).toBe("");

    rerender(view(true));
    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep summary draft");

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep summary draft");
  });

  it("restores a deferred no-summary fork rejected at settlement", () => {
    const onSubmitWithoutSummary = vi.fn();
    const forkSummaryMode = {
      title: "Fork after selected turn",
      description: "Fork without retaining later turns.",
      placeholder: "Optional summary instructions",
      submitLabel: "Fork with summary",
      tooltip: "Fork with generated summary",
      icon: "⑂",
      noSummarySubmitLabel: "Fork without summary",
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
      onSubmitWithoutSummary,
    };
    const view = (disabled: boolean) => (
      <MessageInput
        onSend={vi.fn()}
        draftKey="test-draft"
        placeholder="Message"
        supportsPermissionMode={false}
        supportsThinkingToggle={false}
        disabled={disabled}
        forkSummaryMode={forkSummaryMode}
      />
    );
    const { rerender } = render(view(false));
    const textarea = screen.getByPlaceholderText(
      "Optional summary instructions",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "keep no-summary draft" } });
    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(textarea.value).toBe("");

    rerender(view(true));
    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    expect(onSubmitWithoutSummary).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep no-summary draft");

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });
    expect(onSubmitWithoutSummary).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep no-summary draft");
  });

  it("restores a deferred typed fork when its action throws", () => {
    const onSubmit = vi.fn(() => {
      throw new Error("fork failed");
    });
    const textarea = renderMessageInput(vi.fn(), {
      forkSummaryMode: {
        title: "Fork after selected turn",
        description: "Generate a summary before forking.",
        placeholder: "Optional summary instructions",
        submitLabel: "Fork with summary",
        tooltip: "Fork with generated summary",
        icon: "⑂",
        onCancel: vi.fn(),
        onSubmit,
      },
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "recover after throw" } });
    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    fireEvent.click(screen.getByRole("button", { name: "Fork with summary" }));
    expect(textarea.value).toBe("");

    let thrown: unknown;
    act(() => {
      try {
        voiceButtonState.isListening = false;
        voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toEqual(new Error("fork failed"));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("recover after throw");

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("recover after throw");
  });

  it("sends the current draft as fork summary instructions with Ctrl+Alt+Enter", () => {
    const onForkSummaryShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(vi.fn(), {
      onForkSummaryShortcut,
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "focus on tests" } });
    fireEvent.keyDown(textarea, {
      key: "Enter",
      ctrlKey: true,
      altKey: true,
    });

    expect(onForkSummaryShortcut).toHaveBeenCalledWith("focus on tests");
    expect(textarea.value).toBe("");
  });

  it("recalls the last submission from a blank composer with Up or Ctrl+P", () => {
    const onRecallLastSubmission = vi.fn(() => true);
    const textarea = renderMessageInput(onRecallLastSubmission);

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "p", ctrlKey: true });

    expect(onRecallLastSubmission).toHaveBeenCalledTimes(2);
  });

  it("cancels correction recall with Escape before stopping the turn", () => {
    const onStop = vi.fn();
    const onCancelCorrection = vi.fn();
    function CorrectionRecallHarness() {
      const [correctionActive, setCorrectionActive] = useState(false);
      const draftControlsRef = useRef<
        | Parameters<
            NonNullable<
              ComponentProps<typeof MessageInput>["onDraftControlsReady"]
            >
          >[0]
        | null
      >(null);

      return (
        <MessageInput
          onSend={vi.fn()}
          draftKey="correction-recall-test"
          supportsPermissionMode={false}
          supportsThinkingToggle={false}
          correctionActive={correctionActive}
          onCancelCorrection={() => {
            onCancelCorrection();
            setCorrectionActive(false);
            draftControlsRef.current?.clearDraft();
          }}
          onDraftControlsReady={(controls) => {
            draftControlsRef.current = controls;
          }}
          onRecallLastSubmission={() => {
            const controls = draftControlsRef.current;
            if (!controls) return false;
            controls.setDraft("previous submission");
            setCorrectionActive(true);
            return true;
          }}
          isRunning
          isThinking
          onStop={onStop}
        />
      );
    }

    render(<CorrectionRecallHarness />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("previous submission");

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onCancelCorrection).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("");
    expect(onStop).not.toHaveBeenCalled();
  });

  describe("composer recall drawer", () => {
    const turnRecall = {
      entries: [
        {
          id: "turn-deploy",
          text: "deploy the app",
          preview: "deploy the app",
        },
        {
          id: "turn-debug",
          text: "debug the crash",
          preview: "debug the crash",
        },
        { id: "turn-run", text: "run the tests", preview: "run the tests" },
      ],
    };

    function recallItems() {
      return Array.from(
        document.querySelectorAll(".composer-recall-menu .slash-command-item"),
      );
    }

    function activeRecallItem() {
      return document.querySelector(
        ".composer-recall-menu .slash-command-item.active",
      );
    }

    function recallGoToButtons() {
      return Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".composer-recall-menu .composer-recall-goto",
        ),
      );
    }

    it("opens on Ctrl+ArrowUp and lists prior user turns newest-first", () => {
      const textarea = renderMessageInput(vi.fn(), { turnRecall });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });

      expect(recallItems().map((item) => item.textContent)).toEqual([
        "deploy the app",
        "debug the crash",
        "run the tests",
      ]);
      expect(activeRecallItem()?.textContent).toBe("deploy the app");
    });

    it("prefix-matches the current draft and drops non-matches", () => {
      const textarea = renderMessageInput(vi.fn(), { turnRecall });
      fireEvent.change(textarea, { target: { value: "de" } });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });

      expect(recallItems().map((item) => item.textContent)).toEqual([
        "deploy the app",
        "debug the crash",
      ]);
    });

    it("does not open when nothing prefix-matches", () => {
      const textarea = renderMessageInput(vi.fn(), { turnRecall });
      fireEvent.change(textarea, { target: { value: "zzz" } });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });

      expect(document.querySelector(".composer-recall-menu")).toBeNull();
    });

    it("does not open over an attachment-only draft", () => {
      const textarea = renderMessageInput(vi.fn(), {
        attachments: [TEST_ATTACHMENT],
        turnRecall,
      });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });

      expect(document.querySelector(".composer-recall-menu")).toBeNull();
    });

    it("moves the selection with Arrow keys and drafts on Enter", () => {
      const textarea = renderMessageInput(vi.fn(), {
        turnRecall,
      }) as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      expect(activeRecallItem()?.textContent).toBe("debug the crash");

      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(textarea.value).toBe("debug the crash");
      expect(document.querySelector(".composer-recall-menu")).toBeNull();
    });

    it("drafts the clicked entry", () => {
      const textarea = renderMessageInput(vi.fn(), {
        turnRecall,
      }) as HTMLTextAreaElement;

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
      const runItem = recallItems().find(
        (item) => item.textContent === "run the tests",
      ) as HTMLElement;
      fireEvent.click(runItem);

      expect(textarea.value).toBe("run the tests");
      expect(document.querySelector(".composer-recall-menu")).toBeNull();
    });

    it("closes and keeps the draft on Escape", () => {
      const textarea = renderMessageInput(vi.fn(), {
        turnRecall,
      }) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "de" } });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
      expect(document.querySelector(".composer-recall-menu")).not.toBeNull();

      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(document.querySelector(".composer-recall-menu")).toBeNull();
      expect(textarea.value).toBe("de");
    });

    it("dismisses on any other key so typing continues", () => {
      const textarea = renderMessageInput(vi.fn(), { turnRecall });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
      expect(document.querySelector(".composer-recall-menu")).not.toBeNull();

      const handled = fireEvent.keyDown(textarea, { key: "a" });
      // Not consumed: the keystroke is allowed to reach the composer.
      expect(handled).toBe(true);
      expect(document.querySelector(".composer-recall-menu")).toBeNull();
    });

    it("restores focus loss by closing the drawer", () => {
      const textarea = renderMessageInput(vi.fn(), { turnRecall });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
      expect(document.querySelector(".composer-recall-menu")).not.toBeNull();

      fireEvent.blur(textarea);
      expect(document.querySelector(".composer-recall-menu")).toBeNull();
    });

    it("leaves plain ArrowUp last-submission recall intact", () => {
      const onRecall = vi.fn(() => true);
      const textarea = renderMessageInput(onRecall, { turnRecall });

      fireEvent.keyDown(textarea, { key: "ArrowUp" });

      expect(onRecall).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".composer-recall-menu")).toBeNull();
    });

    it("omits the per-row go-to control when onGoToTurn is absent", () => {
      const textarea = renderMessageInput(vi.fn(), { turnRecall });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });

      expect(recallItems()).toHaveLength(3);
      expect(recallGoToButtons()).toHaveLength(0);
    });

    it("go-to control navigates to the turn id, closing the drawer without changing the draft", () => {
      const onGoToTurn = vi.fn();
      const textarea = renderMessageInput(vi.fn(), {
        turnRecall: { ...turnRecall, onGoToTurn },
      }) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "de" } });

      fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
      // "de" prefix-matches deploy + debug; move selection to the second.
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      expect(activeRecallItem()?.textContent).toBe("debug the crash");

      const gotoButtons = recallGoToButtons();
      expect(gotoButtons).toHaveLength(2);
      fireEvent.click(gotoButtons[1] as HTMLButtonElement);

      // Navigation only: fires the render id, closes the drawer, and leaves the
      // draft untouched (no recall, and no Esc-style restore).
      expect(onGoToTurn).toHaveBeenCalledTimes(1);
      expect(onGoToTurn).toHaveBeenCalledWith("turn-debug");
      expect(document.querySelector(".composer-recall-menu")).toBeNull();
      expect(textarea.value).toBe("de");
    });

    it("opens the drawer from the mobile keyboard recall button", () => {
      const viewport = installMobileKeyboardViewport();
      try {
        const textarea = renderMessageInput(vi.fn(), { turnRecall });
        fireEvent.focus(textarea);
        act(() => viewport.setHeight(480));
        // A prefix draft makes canSubmit true so the compact action row shows.
        fireEvent.change(textarea, { target: { value: "de" } });

        const openButton = document.querySelector(
          ".message-input-keyboard-compact .composer-recall-open",
        ) as HTMLButtonElement | null;
        expect(openButton).toBeTruthy();
        expect(document.querySelector(".composer-recall-menu")).toBeNull();

        fireEvent.pointerDown(openButton as HTMLButtonElement);
        fireEvent.click(openButton as HTMLButtonElement);

        expect(recallItems().map((item) => item.textContent)).toEqual([
          "deploy the app",
          "debug the crash",
        ]);
      } finally {
        viewport.restore();
      }
    });

    it("hides the mobile keyboard recall button when there are no entries", () => {
      const viewport = installMobileKeyboardViewport();
      try {
        const textarea = renderMessageInput(vi.fn(), {
          turnRecall: { entries: [] },
        });
        fireEvent.focus(textarea);
        act(() => viewport.setHeight(480));
        fireEvent.change(textarea, { target: { value: "de" } });

        expect(
          document.querySelector(
            ".message-input-keyboard-compact .composer-recall-open",
          ),
        ).toBeNull();
      } finally {
        viewport.restore();
      }
    });

    it("hides the mobile keyboard recall button when an attachment is present", () => {
      const viewport = installMobileKeyboardViewport();
      try {
        const textarea = renderMessageInput(vi.fn(), {
          attachments: [TEST_ATTACHMENT],
          turnRecall,
        });
        fireEvent.focus(textarea);
        act(() => viewport.setHeight(480));

        expect(
          document.querySelector(
            ".message-input-keyboard-compact .composer-recall-open",
          ),
        ).toBeNull();
      } finally {
        viewport.restore();
      }
    });

    it("hides the mobile keyboard recall button when the toolbar control is hidden", () => {
      const viewport = installMobileKeyboardViewport();
      const visibility = toolbarVisibilityOverrides.value;
      toolbarVisibilityOverrides.value = {
        ...visibility,
        composerRecall: false,
      };
      try {
        const textarea = renderMessageInput(vi.fn(), { turnRecall });
        fireEvent.focus(textarea);
        act(() => viewport.setHeight(480));
        fireEvent.change(textarea, { target: { value: "de" } });

        expect(
          document.querySelector(
            ".message-input-keyboard-compact .composer-recall-open",
          ),
        ).toBeNull();
      } finally {
        toolbarVisibilityOverrides.value = visibility;
        viewport.restore();
      }
    });

    it("still opens the recall drawer with Ctrl+Up when the button is hidden", () => {
      const visibility = toolbarVisibilityOverrides.value;
      toolbarVisibilityOverrides.value = {
        ...visibility,
        composerRecall: false,
      };
      try {
        const textarea = renderMessageInput(vi.fn(), { turnRecall });
        fireEvent.change(textarea, { target: { value: "de" } });

        fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });

        expect(recallItems().map((item) => item.textContent)).toEqual([
          "deploy the app",
          "debug the crash",
        ]);
      } finally {
        toolbarVisibilityOverrides.value = visibility;
      }
    });
  });

  it("opens explicit thinking choices from the toolbar button", () => {
    const onSetMode = vi.fn();
    renderToolbarView({
      mode: "off",
      level: "high",
      effortOptions: [
        { value: "low", label: "Low", description: "Fastest responses" },
        { value: "high", label: "High", description: "Deep reasoning" },
      ],
      onSetMode,
      onSetEffort: vi.fn(),
      onToggleEnabled: vi.fn(),
    });

    const button = screen.getByRole("button", {
      name: /Click to choose/i,
    });
    expect(button.textContent).toContain("Off");

    fireEvent.click(button);

    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Auto" }));

    expect(onSetMode).toHaveBeenCalledWith("auto");
  });

  it("sets toolbar effort choices through Thinking On", () => {
    const onSetMode = vi.fn();
    const onSetEffort = vi.fn();
    renderToolbarView({
      mode: "auto",
      level: "high",
      effortOptions: [
        { value: "high", label: "High", description: "Deep reasoning" },
        {
          value: "xhigh",
          label: "Extra High",
          description: "Extra-high reasoning",
        },
      ],
      onSetMode,
      onSetEffort,
      onToggleEnabled: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: /Click to choose/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Extra High" }));

    expect(onSetEffort).toHaveBeenCalledWith("xhigh");
    expect(onSetMode).toHaveBeenCalledWith("on");
  });

  it("uses the thinking secondary gesture as an off/on toggle", () => {
    const onToggleEnabled = vi.fn();
    renderToolbarView({
      mode: "auto",
      level: "high",
      effortOptions: [
        { value: "high", label: "High", description: "Deep reasoning" },
      ],
      onSetMode: vi.fn(),
      onSetEffort: vi.fn(),
      onToggleEnabled,
    });

    fireEvent.contextMenu(
      screen.getByRole("button", { name: /right-click or long-press/i }),
    );

    expect(onToggleEnabled).toHaveBeenCalledTimes(1);
  });

  it("keeps live thinking controls enabled while the agent is running", () => {
    const onSetMode = vi.fn();
    renderMessageInput(vi.fn(), {
      supportsThinkingToggle: true,
      thinkingProvider: "claude",
      thinkingModel: "test-model",
      isRunning: true,
      isThinking: true,
      onStop: vi.fn(),
      liveThinkingSelection: {
        mode: "on",
        level: "xhigh",
        onSetMode,
        onSetEffort: vi.fn(),
      },
    });

    const button = screen.getByRole("button", {
      name: /Current: Thinking on/i,
    });
    expect(button.textContent).toContain("XHigh");

    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Auto" }));

    expect(onSetMode).toHaveBeenCalledWith("auto");
    expect(mockSetThinkingMode).not.toHaveBeenCalled();
  });

  it("selects direct Grok streaming by default when Grok STT is enabled", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-deepgram", "ya-grok"],
    };

    renderMessageInput();

    expect(
      screen.getByRole("button", { name: "voice" }).dataset.speechMethod,
    ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD);

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    expect(
      screen.getByRole("radio", {
        name: "Grok STT through YA",
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("radio", {
        name: "Grok STT through YA batch",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Deepgram STT/ }));

    expect(mockSetSpeechMethod).toHaveBeenCalledWith("ya-deepgram");
  });

  it("selects direct Grok streaming when a browser xAI key is configured", async () => {
    setBrowserXaiSttApiKey("browser-xai-key");

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "voice" }).dataset.speechMethod,
      ).toBe(XAI_DIRECT_STREAMING_SPEECH_METHOD),
    );
    expect(
      screen.getByRole("radio", {
        name: "Grok STT direct",
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("radio", {
        name: /Grok STT direct batch/,
      }),
    ).toBeNull();
  });

  it("stops active voice capture before opening speech settings", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
    };
    voiceButtonState.isListening = true;

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(mockVoiceStopAndFinalize).toHaveBeenCalledTimes(1);
  });

  it("toggles session voice input on Ctrl+Space from the composer", () => {
    const textarea = renderMessageInput();

    fireEvent.keyDown(textarea, {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });

    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
  });

  it("does not focus the textarea when mobile voice starts or stops", () => {
    const viewport = installMobileKeyboardViewport();
    try {
      const textarea = renderMessageInput();
      const voice = screen.getByRole("button", { name: "voice" });

      fireEvent.click(voice);
      expect(document.activeElement).not.toBe(textarea);

      act(() => voice.focus());
      act(() => voicePropsState.current?.onListeningStop?.());
      expect(document.activeElement).toBe(voice);
    } finally {
      viewport.restore();
    }
  });

  it("replaces selected text only when speech text commits", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    act(() => textarea.focus());
    textarea.setSelectionRange(8, 12);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace this text");
      expect(textarea.selectionStart).toBe(8);
      expect(textarea.selectionEnd).toBe(12);
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace spoken text");
      expect(textarea.selectionStart).toBe("replace spoken".length);
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "cancel",
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace text");
      expect(textarea.selectionStart).toBe("replace".length);
    });
  });

  it("keeps the real draft and caret mode while transcribing; Escape cancels", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft" } });
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(5, 5);
    });

    // Enter the batch processing wait (no interim), e.g. parakeet first-load.
    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")).toBeNull();
    });
    expect(
      document.querySelector(".speech-draft-field")?.classList,
    ).not.toContain("has-interim");
    expect(textarea.selectionStart).toBe(5);

    // The field stays editable while transcription is pending.
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, {
      target: { value: "typed while transcribing" },
    });
    expect(textarea.value).toBe("typed while transcribing");

    // Escape remains the deliberate cancel path and leaves typed text intact.
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("typed while transcribing");
  });

  it("commits the visible interim at its displayed span on manual stop", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "alpha omega" } });
    textarea.setSelectionRange("alpha".length, "alpha".length);

    // Active streaming: provisional text previews inline with a mirror caret
    // immediately after the visible dictated phrase.
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("live words");
    });
    const interim = await waitFor(() => {
      const el = document.querySelector(".speech-interim-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(interim.nextElementSibling?.classList).toContain(
      "speech-interim-caret",
    );
    // Explicit Stop freezes exactly what the mirror showed into the editable
    // draft before finalization clears the provisional rendering.
    let committedVisibleInterim = false;
    act(() => {
      screen.getAllByRole("button", { name: "voice" })[0]?.focus();
      committedVisibleInterim =
        voicePropsState.current?.onListeningStop?.() === true;
      voicePropsState.current?.onInterimTranscript?.("");
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
    });
    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")).toBeNull();
      expect(textarea.value).toBe("alpha live words omega");
    });
    expect(committedVisibleInterim).toBe(true);
    expect(
      document.querySelector(".speech-draft-field")?.classList,
    ).not.toContain("has-interim");
    expect(document.activeElement).toBe(textarea);

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
  });

  it("does not insert a Listening label into the draft", async () => {
    renderMessageInput();

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });

    await waitFor(() =>
      expect(document.querySelector(".speech-draft-mirror")).toBeNull(),
    );
  });

  it("never duplicates pending statuses inside the draft", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft" } });
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(5, 5);
    });

    // Two overlapping recordings used to create "Transcribing… Transcribing…
    // (2)" in the mirror and hide the native caret.
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")).toBeNull();
    });
    expect(
      document.querySelector(".speech-draft-field")?.classList,
    ).not.toContain("has-interim");
    expect(textarea.value).toBe("draft");
    expect(textarea.selectionStart).toBe(5);
  });

  it("retires an older failed target while a newer recording stays active", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft" } });

    let firstTargetId: string | undefined;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      firstTargetId =
        voicePropsState.current?.getTranscriptionContext?.().speechTargetId;
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });

    act(() => {
      voicePropsState.current?.onTranscriptionSettled?.({
        speechTargetId: firstTargetId,
        status: "error",
      });
      voicePropsState.current?.onInterimTranscript?.("new recording");
    });

    const interim = await waitFor(() => {
      const el = document.querySelector(".speech-interim-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(interim.textContent).toBe("new recording");
  });

  it("does not revive a completed recording in a later provisional preview", async () => {
    renderMessageInput();

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });
    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.(null);
    });

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("fresh words");
    });

    const interim = await waitFor(() => {
      const el = document.querySelector(".speech-interim-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(interim.textContent).toBe("fresh words");
  });

  it("does not grace-delay the selection that started the mic transaction", () => {
    vi.useFakeTimers();
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    act(() => textarea.focus());
    textarea.setSelectionRange(8, 12);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });
    fireEvent.select(textarea);

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    expect(textarea.value).toBe("replace spoken text");
  });

  it("resumes speech after text typed at the live caret", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onTranscript?.("spoken first");
    });

    await waitFor(() => expect(textarea.value).toBe("spoken first"));
    const withTyping = `${textarea.value} [typing this]`;
    fireEvent.change(textarea, {
      target: {
        value: withTyping,
        selectionStart: withTyping.length,
        selectionEnd: withTyping.length,
      },
    });
    expect(mockVoiceBeginInsertionBoundary).toHaveBeenCalledOnce();

    act(() => {
      voicePropsState.current?.onTranscript?.("resumed speech");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("spoken first [typing this] resumed speech");
      expect(textarea.selectionStart).toBe(textarea.value.length);
    });
  });

  it("resumes speech at a caret moved manually while listening", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "alpha omega" } });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onTranscript?.("spoken first");
    });
    await waitFor(() =>
      expect(textarea.value).toBe("alpha omega spoken first"),
    );

    textarea.setSelectionRange("alpha".length, "alpha".length);
    fireEvent.select(textarea);
    expect(mockVoiceBeginInsertionBoundary).toHaveBeenCalledOnce();
    act(() => {
      voicePropsState.current?.onTranscript?.("resumed speech");
    });

    await waitFor(() =>
      expect(textarea.value).toBe("alpha resumed speech omega spoken first"),
    );
  });

  it("keeps an interim fragment anchored until its final arrives", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "existing text" } });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("spoken first");
    });
    await waitFor(() =>
      expect(document.querySelector(".speech-interim-inline")).not.toBeNull(),
    );

    textarea.setSelectionRange(0, 0);
    fireEvent.pointerUp(textarea);

    expect(mockVoiceBeginInsertionBoundary).not.toHaveBeenCalled();
    expect(textarea.value).toBe("existing text");

    act(() => {
      voicePropsState.current?.onInterimTranscript?.(
        "spoken first still speaking",
      );
    });
    expect(textarea.value).toBe("existing text");
    expect(document.querySelector(".speech-interim-inline")?.textContent).toBe(
      "spoken first still speaking",
    );

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken first still speaking");
    });
    await waitFor(() =>
      expect(textarea.value).toBe("existing text spoken first still speaking"),
    );
    expect(mockVoiceBeginInsertionBoundary).toHaveBeenCalledOnce();

    act(() => {
      voicePropsState.current?.onTranscript?.("resumed speech");
    });
    await waitFor(() =>
      expect(textarea.value).toBe(
        "resumed speech existing text spoken first still speaking",
      ),
    );
  });

  it("keeps a stopped batch result at its captured mapped target", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "alpha suffix" } });
    textarea.setSelectionRange("alpha".length, "alpha".length);
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onListeningStop?.();
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });

    const withTyping = `${textarea.value} [typed later]`;
    fireEvent.change(textarea, {
      target: {
        value: withTyping,
        selectionStart: withTyping.length,
        selectionEnd: withTyping.length,
      },
    });
    act(() => {
      voicePropsState.current?.onTranscript?.("batch speech");
    });

    await waitFor(() =>
      expect(textarea.value).toBe("alpha batch speech suffix [typed later]"),
    );
  });

  it("leaves a selected replacement untouched when speech is cancelled first", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    act(() => textarea.focus());
    textarea.setSelectionRange(8, 12);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "cancel",
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("replace this text");
      expect(textarea.selectionStart).toBe(8);
      expect(textarea.selectionEnd).toBe(12);
    });
  });

  it("replaces a hot-mic selection with the next final chunk after grace", () => {
    vi.useFakeTimers();
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    act(() => textarea.focus());

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });

    textarea.setSelectionRange(8, 12);
    fireEvent.select(textarea);

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    expect(textarea.value).toBe("replace this text");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(textarea.value).toBe("replace spoken text");
    expect(textarea.selectionStart).toBe("replace spoken".length);
  });

  it("lets a manual edit cancel a pending hot-mic selection replacement", () => {
    vi.useFakeTimers();
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "replace this text" } });
    act(() => textarea.focus());

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });

    textarea.setSelectionRange(8, 12);
    fireEvent.select(textarea);

    act(() => {
      voicePropsState.current?.onTranscript?.("spoken");
    });

    fireEvent.change(textarea, { target: { value: "replace typed text" } });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(textarea.value).toBe("replace typed text");
  });

  it("renders interim speech at the current insertion point", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "hello world" } });
    act(() => textarea.focus());
    textarea.setSelectionRange(5, 5);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("there");
    });

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")?.textContent).toBe(
        "hello there world",
      );
      expect(textarea.value).toBe("hello world");
      expect(textarea.selectionStart).toBe(5);
    });
  });

  it("queues a selected replacement behind the current interim", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "alpha beta gamma" } });
    act(() => textarea.focus());
    textarea.setSelectionRange(
      "alpha beta gamma".length,
      "alpha beta gamma".length,
    );

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("draft");
    });

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")?.textContent).toBe(
        "alpha beta gamma draft",
      );
    });

    textarea.setSelectionRange("alpha ".length, "alpha beta".length);
    fireEvent.select(textarea);

    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")?.textContent).toBe(
        "alpha beta gamma draft",
      );
      expect(textarea.value).toBe("alpha beta gamma");
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("draft");
    });
    await waitFor(() => expect(textarea.value).toBe("alpha beta gamma draft"));

    act(() => {
      voicePropsState.current?.onTranscript?.("replacement");
    });
    await waitFor(() =>
      expect(textarea.value).toBe("alpha replacement gamma draft"),
    );
  });

  it("uses selected text context to case speech replacements", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Ok, look again." } });
    act(() => textarea.focus());
    textarea.setSelectionRange("Ok, ".length, "Ok, look".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Focus");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Ok, focus again.");
    });
  });

  it("replaces the previous speech-owned span from provider metadata", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Testing.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Testing.");
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("Testing. again.", {
        replacePreviousTranscriptChars: "Testing.".length,
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Testing. again.");
    });
  });

  it("replaces a corrected streaming segment after several final chunks", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Audio isn't done.");
      voicePropsState.current?.onTranscript?.("Empty final box.");
      voicePropsState.current?.onTranscript?.("Blocks");
      voicePropsState.current?.onTranscript?.(", blocks");
      voicePropsState.current?.onTranscript?.(", empty, five");
      voicePropsState.current?.onTranscript?.("o blocks.");
      voicePropsState.current?.onTranscript?.("Empty, final.");
      voicePropsState.current?.onTranscript?.("Blocks.");
    });

    const previousSegment =
      "Blocks, blocks, empty, five o blocks. Empty, final. Blocks.";
    await waitFor(() => {
      expect(textarea.value).toBe(
        `Audio isn't done. Empty final box. ${previousSegment}`,
      );
    });

    act(() => {
      voicePropsState.current?.onTranscript?.(
        "Blocks, blocks, empty final blocks, empty final blocks.",
        { replacePreviousTranscriptChars: previousSegment.length },
      );
    });

    await waitFor(() => {
      expect(textarea.value).toBe(
        "Audio isn't done. Empty final box. Blocks, blocks, empty final blocks, empty final blocks.",
      );
    });
  });

  it("inserts consecutive final speech chunks at a middle cursor", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "prefix suffix" } });
    act(() => textarea.focus());
    textarea.setSelectionRange("prefix".length, "prefix".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("first.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. suffix");
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("second.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. second. suffix");
    });
  });

  it("moves a pending batch target after earlier speech inserted at the same cursor", async () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "prefix suffix" } });
    act(() => textarea.focus());
    textarea.setSelectionRange("prefix".length, "prefix".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
    });
    const firstTarget =
      voicePropsState.current?.getTranscriptionContext?.().speechTargetId;
    expect(firstTarget).toBeTruthy();

    act(() => {
      voicePropsState.current?.onListeningStop?.();
      voicePropsState.current?.onListeningStart?.();
    });
    const secondTarget =
      voicePropsState.current?.getTranscriptionContext?.().speechTargetId;
    expect(secondTarget).toBeTruthy();
    expect(secondTarget).not.toBe(firstTarget);

    act(() => {
      voicePropsState.current?.onTranscript?.("first.", {
        speechTargetId: firstTarget,
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. suffix");
    });

    act(() => {
      voicePropsState.current?.onTranscript?.("second.", {
        speechTargetId: secondTarget,
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("prefix first. second. suffix");
    });
  });

  it("keeps active streaming final chunks in the composer", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("Okay");
      voicePropsState.current?.onTranscript?.("Okay.");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Okay.");
    });

    act(() => {
      voicePropsState.current?.onInterimTranscript?.("Does it work");
      voicePropsState.current?.onTranscript?.("Does it work at all?");
    });

    await waitFor(() => {
      expect(textarea.value).toBe("Okay. Does it work at all?");
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("submits committed speech when Smart Turn send follows immediately", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Okay.");
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
      });
    });

    await waitFor(() => {
      expectSubmission(onSend, "[ASR] Okay.", "direct");
      expect(textarea.value).toBe("");
    });
    expect(mockVoiceContinueAfterSpeechSend).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(textarea);
  });

  it("sends the visible interim snapshot after speech settles", async () => {
    window.localStorage.setItem(UI_KEYS.speechAsrAttributionMs, "1000");
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "alpha omega" } });
    textarea.setSelectionRange("alpha".length, "alpha".length);

    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("provisional words");
    });

    const send = screen.getByRole("button", { name: /toolbarSend/ });
    expect(send.textContent).toContain("ASR");
    fireEvent.click(send);

    expect(mockVoiceStopAndFinalize).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onTranscript?.("backend final words");
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    await waitFor(() => {
      expectSubmission(onSend, "[ASR] alpha provisional words omega", "direct");
    });
    expect(onSend.mock.calls[0]?.[0]).not.toContain("backend final words");
  });

  it("keeps a new draft typed while a speech queue settles", async () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onQueue,
      supportsSteering: true,
      primaryActionKind: "queue",
    }) as HTMLTextAreaElement;

    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("previous turn");
    });

    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));
    fireEvent.change(textarea, { target: { value: "next turn draft" } });

    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onTranscript?.("previous turn final");
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    await waitFor(() => {
      expectSubmission(onQueue, "previous turn", "deferred");
      expect(textarea.value).toBe("next turn draft");
    });
    expect(onQueue.mock.calls[0]?.[0]).not.toContain("previous turn final");
  });

  it("restores a detached speech draft without replacing newer text", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "previous typed text" } });

    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    fireEvent.click(screen.getByLabelText("toolbarSend"));
    fireEvent.change(textarea, { target: { value: "next turn draft" } });
    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("previous typed text\n\nnext turn draft");
  });

  it("starts deferred-delivery ASR timing at backend settlement", () => {
    vi.useFakeTimers();
    window.localStorage.setItem(UI_KEYS.speechAsrAttributionMs, "500");
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "visible at press" } });

    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    fireEvent.click(screen.getByLabelText("toolbarSend"));

    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onTranscript?.("settled backend words");
      vi.advanceTimersByTime(1000);
    });
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });
    expectSubmission(onSend, "[ASR] visible at press", "direct");
  });

  it("shows no speech prefix cue and sends verbatim when prefixing is Off", async () => {
    window.localStorage.setItem(UI_KEYS.speechMessagePrefixMode, "off");
    window.localStorage.setItem(UI_KEYS.speechAsrAttributionMs, "1000");
    const onSend = vi.fn();
    renderMessageInput(vi.fn(), {
      onSend,
    });

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Plain speech.");
    });

    const send = screen.getByLabelText("toolbarSend");
    expect(send.textContent).not.toContain("ASR");
    fireEvent.click(send);

    await waitFor(() => expectSubmission(onSend, "Plain speech.", "direct"));
  });

  it("keeps an empty speech-triggered send as a no-op", () => {
    const onSend = vi.fn();
    renderMessageInput(vi.fn(), { onSend });

    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("closes mobile keyboard focus after Smart Turn sends", async () => {
    const viewport = installMobileKeyboardViewport();
    try {
      const onSend = vi.fn();
      const textarea = renderMessageInput(vi.fn(), {
        onSend,
      }) as HTMLTextAreaElement;
      act(() => textarea.focus());

      act(() => {
        voicePropsState.current?.onListeningStart?.();
        voicePropsState.current?.onTranscript?.("Okay.");
        voicePropsState.current?.onTranscript?.("", {
          smartTurnCommand: "send",
        });
      });

      await waitFor(() => {
        expectSubmission(onSend, "[ASR] Okay.", "direct");
        expect(textarea.value).toBe("");
      });
      expect(document.activeElement).not.toBe(textarea);
    } finally {
      viewport.restore();
    }
  });

  it("keeps mobile keyboard focus when Smart Turn auto-send is held", async () => {
    const viewport = installMobileKeyboardViewport();
    try {
      const onSend = vi.fn();
      const textarea = renderMessageInput(vi.fn(), {
        onSend,
      }) as HTMLTextAreaElement;
      act(() => textarea.focus());
      act(() => {
        voicePropsState.current?.onListeningStart?.();
        voicePropsState.current?.onTranscript?.("Review this.");
      });
      await waitFor(() => expect(textarea.value).toBe("Review this."));

      fireEvent.change(textarea, {
        target: { value: "Review this. manual edit" },
      });
      act(() => {
        voicePropsState.current?.onTranscript?.("", {
          smartTurnCommand: "send",
          smartTurnAutoSend: true,
        });
      });

      expect(onSend).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(textarea);
    } finally {
      viewport.restore();
    }
  });

  it("holds a Smart Turn auto-send after a manual non-whitespace edit", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Hello world.");
    });
    await waitFor(() => expect(textarea.value).toBe("Hello world."));

    // The user types into the composer mid-dictation.
    fireEvent.change(textarea, { target: { value: "Hello world. mine" } });

    // The automatic endpoint send must not submit; the draft is left for review.
    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });
    await waitFor(() => expect(textarea.value).toBe("Hello world. mine"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("auto-sends with the default microphone prefix for a speech-only draft", async () => {
    window.localStorage.removeItem(UI_KEYS.speechMessagePrefixMode);
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    // Speech-inserted finals go through setDraft, not onChange, so they do not
    // count as a manual edit and the auto-send still fires.
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Ship it.");
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });
    await waitFor(() => {
      expectSubmission(onSend, "🎤 Ship it.", "direct");
      expect(textarea.value).toBe("");
    });
  });

  it("still auto-sends after a whitespace-only manual edit", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Go now.");
    });
    await waitFor(() => expect(textarea.value).toBe("Go now."));

    // A trailing space adds no non-whitespace text, so the auto-send proceeds.
    fireEvent.change(textarea, { target: { value: "Go now. " } });
    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });
    await waitFor(() => expectSubmission(onSend, "[ASR] Go now.", "direct"));
  });

  it("submits an explicit spoken send even after a manual edit", async () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onSend,
    }) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("Reply done.");
    });
    await waitFor(() => expect(textarea.value).toBe("Reply done."));

    fireEvent.change(textarea, { target: { value: "Reply done. plus" } });

    // An explicit spoken `send` (no smartTurnAutoSend) is never held.
    act(() => {
      voicePropsState.current?.onTranscript?.("", { smartTurnCommand: "send" });
    });
    await waitFor(() => {
      expectSubmission(onSend, "[ASR] Reply done. plus", "direct");
      expect(textarea.value).toBe("");
    });
  });

  it("hides a stored YA-routed Grok batch method from the method list", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));
    expect(
      screen.queryByRole("radio", {
        name: "Grok STT through YA batch",
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole("radio", {
          name: "Grok STT direct",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("Smart Turn")).toBeDefined();

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Grok STT through YA",
      }),
    );
    expect(mockSetSpeechMethod).toHaveBeenCalledWith("ya-grok");
  });

  it("shows Smart Turn for direct Grok streaming without server capabilities", () => {
    remoteBasePathState.basePath = "/ygraehl";
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {},
    };
    modelSettingsState.speechMethod = XAI_DIRECT_STREAMING_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(screen.getByText("Smart Turn")).toBeDefined();
    expect(screen.queryByText("Grok STT audio")).toBeNull();
  });

  it("hides a stored YA-routed Grok batch method in relay mode", () => {
    remoteBasePathState.basePath = "/ygraehl";
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;

    renderMessageInput();

    fireEvent.contextMenu(screen.getByRole("button", { name: "voice" }));

    expect(
      screen.queryByRole("radio", {
        name: "Grok STT through YA batch",
      }),
    ).toBeNull();
  });

  it("keeps Up as native navigation when the composer has text", () => {
    const onRecallLastSubmission = vi.fn(() => true);
    const textarea = renderMessageInput(onRecallLastSubmission);

    fireEvent.change(textarea, { target: { value: "still editing" } });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });

    expect(onRecallLastSubmission).not.toHaveBeenCalled();
  });

  it("recalls with Ctrl+P even when accidental text is present", () => {
    const onRecallLastSubmission = vi.fn(() => true);
    const textarea = renderMessageInput(onRecallLastSubmission);

    fireEvent.change(textarea, { target: { value: "oops" } });
    fireEvent.keyDown(textarea, { key: "p", ctrlKey: true });

    expect(onRecallLastSubmission).toHaveBeenCalledTimes(1);
  });

  it("does not accept an empty-draft suggestion over an attachment", () => {
    const onDismissPromptSuggestion = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        attachments: [TEST_ATTACHMENT],
        promptSuggestion: "Suggested follow-up",
        onDismissPromptSuggestion,
      },
    ) as HTMLTextAreaElement;

    expect(screen.queryByText("Suggested follow-up")).toBeNull();
    fireEvent.keyDown(textarea, { key: "Tab" });

    expect(textarea.value).toBe("");
    expect(onDismissPromptSuggestion).not.toHaveBeenCalled();
  });

  it("shows slash suggestions from a leading slash token", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: ["compact", "goal"].map(createClientSlashCommand),
        onCustomCommand: vi.fn(() => false),
      },
    );

    fireEvent.change(textarea, { target: { value: "/co" } });

    expect(screen.getByRole("menuitem", { name: "/compact" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "/goal" })).toBeNull();
  });

  it("keeps root slash completion closed when a draft has an attachment", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        attachments: [TEST_ATTACHMENT],
        slashCommands: ["compact", "goal"].map(createClientSlashCommand),
        onCustomCommand: vi.fn(() => false),
      },
    );

    fireEvent.change(textarea, { target: { value: "/co" } });

    expect(screen.queryByRole("menuitem", { name: "/compact" })).toBeNull();
  });

  it("accepts a typed slash suggestion into the composer", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: ["compact", "goal"].map(createClientSlashCommand),
        onCustomCommand: vi.fn(() => false),
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/co" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("/compact ");
  });

  it("shows and inserts provider-owned slash argument completions", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: [
          {
            name: "goal",
            description:
              "Keep working toward a verifiable end state until it is met",
            argumentHint: "<verifiable end state>",
            argumentCompletions: [
              { value: "clear", description: "Remove the current goal" },
              { value: "pause", description: "Pause the current goal" },
              { value: "resume", description: "Resume the current goal" },
            ],
            invocation: { kind: "native", prefix: "/" },
          },
        ],
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/go" } });
    const goalCommand = screen.getByRole("menuitem", { name: "/goal" });
    expect(goalCommand.textContent).toContain("<verifiable end state>");
    expect(goalCommand.textContent).toContain(
      "Keep working toward a verifiable end state until it is met",
    );
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("/goal ");
    expect(screen.getByRole("menuitem", { name: "/goal clear" })).toBeTruthy();
    expect(screen.getByText("Remove the current goal")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/goal clear ");
  });

  it("offers the current goal on bare /goal, tabs it in, and submits bare Enter", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        slashCommands: [
          {
            name: "goal",
            description: "",
            argumentCompletions: [
              { value: "Ship the revised goal", description: "Current goal" },
              { value: "clear" },
            ],
          },
        ],
      },
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/goal" } });
    expect(
      screen.getByRole("menuitem", { name: "/goal Ship the revised goal" }),
    ).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/goal Ship the revised goal ");
    fireEvent.change(textarea, { target: { value: "/goal" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/goal", expect.anything());
  });

  it("submits instead of completing a slash token after existing text", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        slashCommands: [
          {
            name: "doubt",
            description: "Verify independently",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "current",
            },
          },
        ],
        onCustomCommand: vi.fn(() => false),
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "please /dou" } });

    expect(screen.queryByRole("menuitem", { name: "$doubt" })).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expectSubmission(onSend, "please /dou", "direct");
  });

  it("submits instead of completing while the caret is inside a draft", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        slashCommands: [
          {
            name: "doubt",
            description: "Verify independently",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "current",
            },
          },
        ],
        onCustomCommand: vi.fn(() => false),
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: {
        value: "before /dou after",
        selectionStart: 11,
        selectionEnd: 11,
      },
    });

    expect(screen.queryByRole("menuitem", { name: "$doubt" })).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expectSubmission(onSend, "before /dou after", "direct");
  });

  it("hides slash suggestions once the command is completely typed", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: ["clear", "compact"].map(createClientSlashCommand),
        onCustomCommand: vi.fn(() => false),
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/clear" } });

    expect(screen.queryByRole("menuitem", { name: "/clear" })).toBeNull();
  });

  it("submits a completed slash suggestion without the inserted space", async () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        slashCommands: ["clear"].map(createClientSlashCommand),
        onCustomCommand: vi.fn(() => false),
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/cl" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe("/clear "));
    fireEvent.keyDown(textarea, { key: "Enter" });

    expectSubmission(onSend, "/clear", "direct");
    restoreMatchMedia();
  });

  it("recognizes a provider-canonical skill token inside ordinary text", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: [
          {
            name: "doubt",
            description: "Verify independently",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "current",
            },
          },
        ],
        onCustomCommand: vi.fn(() => false),
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "please /doubt" } });

    expect(screen.queryByRole("menuitem", { name: "$doubt" })).toBeNull();
    expect(screen.getByText("Recognized skill:")).toBeTruthy();
    expect(screen.getByText("$doubt")).toBeTruthy();
  });

  it("shows resolved and soft-unrecognized skill feedback", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: [
          {
            name: "doubt",
            description: "Verify independently",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "current",
            },
          },
        ],
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "use /doubt" } });
    expect(screen.getByText("Recognized skill:")).toBeTruthy();
    expect(screen.getByText("$doubt")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "use $missing" } });
    expect(screen.getByText("Skill not found:")).toBeTruthy();
    expect(screen.getByText("$missing")).toBeTruthy();
    expect(screen.getByText("Text will still be sent.")).toBeTruthy();
  });

  it("does not infer a missing skill from stale inventory", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: [
          {
            name: "doubt",
            description: "Verify independently",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "stale",
            },
          },
        ],
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "use $doubt" } });
    expect(screen.queryByText("Recognized skill:")).toBeNull();

    fireEvent.change(textarea, { target: { value: "use $missing" } });
    expect(screen.queryByText("Skill not found:")).toBeNull();
  });

  it("prefers a native root completion and disables completion after text", () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        slashCommands: [
          {
            name: "goal",
            description: "Set a native goal",
            invocation: { kind: "native", prefix: "/" },
          },
          {
            name: "goal",
            description: "Invoke the goal skill",
            invocation: {
              kind: "skill",
              prefix: "$",
              inventoryState: "current",
            },
          },
        ],
      },
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/go" } });
    expect(screen.getByRole("menuitem", { name: "/goal" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "$goal" })).toBeNull();

    fireEvent.change(textarea, { target: { value: "please /go" } });
    expect(screen.queryByRole("menuitem", { name: "$goal" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "/goal" })).toBeNull();
  });

  it("shows the isearch key guide on shortcut help hover while search is active", async () => {
    renderMessageInput();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SESSION_ISEARCH_GUIDE_EVENT, {
          detail: { active: true, scope: "all" },
        }),
      );
    });

    const shortcutsButton = screen.getByRole("button", {
      name: "Session keyboard shortcuts",
    });
    expect(screen.queryByText("Previous match")).toBeNull();
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.mouseEnter(shortcutsButton);

    expect(await screen.findByText("Previous match")).toBeTruthy();
    expect(screen.getByText("Previous / next match")).toBeTruthy();
    expect(screen.getByText("Match preview / rail mark jumps")).toBeTruthy();
    expect(screen.getByText("Cancel / restore focus")).toBeTruthy();
    expect(screen.getByText("User turns")).toBeTruthy();
    expect(screen.getByText("Full session")).toBeTruthy();
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(shortcutsButton.parentElement as Element);

    await waitFor(() => {
      expect(screen.queryByText("Previous match")).toBeNull();
    });
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SESSION_ISEARCH_GUIDE_EVENT, {
          detail: { active: false, scope: "all" },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("Previous match")).toBeNull();
    });
    expect(shortcutsButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the Chrome-safe user search fallback in shortcut help", async () => {
    renderMessageInput();

    fireEvent.click(
      screen.getByRole("button", { name: "Session keyboard shortcuts" }),
    );

    const row = screen
      .getByText("User-turn reverse search")
      .closest(".session-shortcuts-row");
    const keys = Array.from(row?.querySelectorAll("kbd") ?? []).map(
      (key) => key.textContent,
    );

    expect(keys).toEqual(["Ctrl", "R", "Ctrl", "Alt", "R"]);
  });

  it("shows the full-session search shortcut in shortcut help", async () => {
    renderMessageInput();

    fireEvent.click(
      screen.getByRole("button", { name: "Session keyboard shortcuts" }),
    );

    const row = screen
      .getByText("Full-session reverse search")
      .closest(".session-shortcuts-row");
    const keys = Array.from(row?.querySelectorAll("kbd") ?? []).map(
      (key) => key.textContent,
    );

    expect(keys).toEqual(["Ctrl", "Alt", "S"]);
  });

  it("shows the full-pane composer shortcut in shortcut help", () => {
    renderMessageInput();

    fireEvent.click(
      screen.getByRole("button", { name: "Session keyboard shortcuts" }),
    );

    const row = screen
      .getByText("Expand / restore composer")
      .closest(".session-shortcuts-row");
    const keys = Array.from(row?.querySelectorAll("kbd") ?? []).map(
      (key) => key.textContent,
    );

    expect(keys).toEqual(["Ctrl", "U"]);
  });

  it("shows the Project Queue Ctrl+Enter binding in shortcut help", async () => {
    renderMessageInput(vi.fn(), { onProjectQueue: vi.fn(), onQueue: vi.fn() });

    fireEvent.click(
      screen.getByRole("button", { name: "Session keyboard shortcuts" }),
    );

    const row = screen
      .getByText("Queue for Project Queue")
      .closest(".session-shortcuts-row");
    const keys = Array.from(row?.querySelectorAll("kbd") ?? []).map(
      (key) => key.textContent,
    );

    expect(keys).toEqual(["Ctrl", "Enter"]);
  });

  it("hides stop while a running composer has queued text", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: true,
        onQueue: vi.fn(),
        onStop,
      },
    );

    fireEvent.change(textarea, { target: { value: "still editable" } });

    expect(screen.getByLabelText("toolbarQueueLabel")).toBeTruthy();
    expect(screen.queryByLabelText("toolbarStop")).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("stops the current turn with Escape from the composer", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: true,
        onStop,
      },
    );

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stops active voice capture with Escape before stopping the current turn", () => {
    voiceButtonState.isListening = true;
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: true,
        onStop,
      },
    );

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("leaves Escape alone when the current turn is not stoppable", () => {
    const onStop = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        isRunning: true,
        isThinking: false,
        onStop,
      },
    );

    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onStop).not.toHaveBeenCalled();
  });

  it("cancels the newest queued message with Ctrl+K", () => {
    const onCancelLatestDeferred = vi.fn(() => true);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onCancelLatestDeferred,
      },
    );

    fireEvent.keyDown(textarea, { key: "k", ctrlKey: true });

    expect(onCancelLatestDeferred).toHaveBeenCalledTimes(1);
  });

  it("starts a /btw aside with Ctrl+B and clears accepted text", () => {
    const onBtwShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onBtwShortcut,
      },
    );

    fireEvent.change(textarea, { target: { value: "side question" } });
    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });

    expect(onBtwShortcut).toHaveBeenCalledWith("side question");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps Ctrl+B text when /btw is not accepted", () => {
    const onBtwShortcut = vi.fn(() => false);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onBtwShortcut,
      },
    );

    fireEvent.change(textarea, { target: { value: "not supported" } });
    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });

    expect(onBtwShortcut).toHaveBeenCalledWith("not supported");
    expect((textarea as HTMLTextAreaElement).value).toBe("not supported");
  });

  it("starts a /btw aside from the toolbar button", () => {
    const onBtwShortcut = vi.fn(() => true);
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onBtwShortcut,
      },
    );

    fireEvent.change(textarea, { target: { value: "tap target" } });
    fireEvent.click(screen.getByRole("button", { name: /Start \/btw aside/ }));

    expect(onBtwShortcut).toHaveBeenCalledWith("tap target");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("marks the /btw toolbar button active for focused aside mode", () => {
    const onBtwShortcut = vi.fn(() => false);
    renderMessageInput(
      vi.fn(() => true),
      {
        btwActive: true,
        onBtwShortcut,
      },
    );

    const button = screen.getByRole("button", {
      name: /Composer is focused on a \/btw aside/,
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(onBtwShortcut).toHaveBeenCalledWith("");
  });

  it("marks a focused /btw pane without claiming footer routing", () => {
    const onBtwShortcut = vi.fn(() => false);
    renderMessageInput(
      vi.fn(() => true),
      {
        btwToolbarMode: "focused-pane",
        onBtwShortcut,
      },
    );

    const button = screen.getByRole("button", {
      name: /click to focus its composer/,
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(onBtwShortcut).toHaveBeenCalledWith("");
  });

  it("lets a pane-focused /btw click move focus after footer refocus", () => {
    vi.useFakeTimers();
    const paneComposer = document.createElement("textarea");
    document.body.append(paneComposer);
    const onBtwShortcut = vi.fn(() => {
      window.setTimeout(() => paneComposer.focus(), 0);
      return false;
    });
    renderMessageInput(
      vi.fn(() => true),
      {
        btwToolbarMode: "focused-pane",
        onBtwShortcut,
      },
    );

    try {
      fireEvent.click(
        screen.getByRole("button", { name: /click to focus its composer/ }),
      );
      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(document.activeElement).toBe(paneComposer);
    } finally {
      paneComposer.remove();
    }
  });

  it("marks the /btw toolbar button when an aside can be focused", () => {
    renderMessageInput(
      vi.fn(() => true),
      {
        btwHasAsides: true,
        onBtwShortcut: vi.fn(() => false),
      },
    );

    const button = screen.getByRole("button", {
      name: /Focus existing \/btw aside/,
    });

    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it.each(["keyboard", "button"])(
    "clears the composer through the textarea undo stack via %s",
    (input) => {
      const previousExecCommand = document.execCommand;
      const execCommand = vi.fn(() => true);
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: execCommand,
      });
      const textarea = renderMessageInput();

      try {
        fireEvent.change(textarea, { target: { value: "undoable draft" } });
        if (input === "keyboard") {
          fireEvent.keyDown(textarea, { key: "g", ctrlKey: true });
        } else {
          fireEvent.click(
            screen.getByRole("button", { name: "Clear composer" }),
          );
        }

        expect(execCommand).toHaveBeenCalledWith("delete");
        expect((textarea as HTMLTextAreaElement).value).toBe("");
      } finally {
        if (previousExecCommand) {
          Object.defineProperty(document, "execCommand", {
            configurable: true,
            value: previousExecCommand,
          });
        } else {
          Reflect.deleteProperty(document, "execCommand");
        }
      }
    },
  );

  it("shows stale last activity in the composer chrome", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:06:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:00:00.000Z",
      },
    );

    expect(screen.getByText("6m ago")).toBeTruthy();
  });

  it("uses compact last-activity wording before 30 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:28:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:20:00.000Z",
      },
    );

    expect(screen.getByText("8m ago")).toBeTruthy();
    expect(screen.queryByText("Last activity 8m ago")).toBeNull();
  });

  it("shows transcript position age even when session activity age is fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:04:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:03:00.000Z",
        positionTimestampMs: new Date("2026-04-26T11:54:00.000Z").getTime(),
      },
    );

    expect(screen.getByText("at 10m ago")).toBeTruthy();
    expect(screen.queryByText("1m ago")).toBeNull();
  });

  it("reads the latest frame-coalesced transcript position", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:04:00.000Z"));
    let pendingFrame: FrameRequestCallback | null = null;
    const positionTimestampStore = createTranscriptPositionStore({
      request: (callback) => {
        pendingFrame = callback;
        return 1;
      },
      cancel: () => {
        pendingFrame = null;
      },
    });

    renderMessageInput(
      vi.fn(() => true),
      { positionTimestampStore },
    );
    positionTimestampStore.publish(
      new Date("2026-04-26T11:50:00.000Z").getTime(),
    );
    positionTimestampStore.publish(
      new Date("2026-04-26T11:54:00.000Z").getTime(),
    );
    expect(screen.queryByText(/at .* ago/)).toBeNull();

    act(() => {
      const frame = pendingFrame;
      pendingFrame = null;
      frame?.(0);
    });

    expect(screen.getByText("at 10m ago")).toBeTruthy();
  });

  it("suppresses transcript position age when it matches session activity age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:06:30.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:00:30.000Z",
        positionTimestampMs: new Date("2026-04-26T12:00:00.000Z").getTime(),
      },
    );

    expect(screen.getByText("6m ago")).toBeTruthy();
    expect(screen.queryByText("at 6m ago")).toBeNull();
  });

  it("keeps long-form last activity wording after 30 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:35:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:00:00.000Z",
      },
    );

    expect(screen.getByText("Last activity 35m")).toBeTruthy();
  });

  it("keeps ok liveness from duplicating stale last-activity age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:06:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        lastActivityAt: "2026-04-26T12:00:00.000Z",
        sessionLiveness: {
          checkedAt: "2026-04-26T12:06:00.000Z",
          derivedStatus: "verified-progressing",
          activeWorkKind: "agent-turn",
          state: "in-turn",
          evidence: ["provider-message"],
          lastProviderMessageAt: "2026-04-26T12:01:00.000Z",
          lastRawProviderEventAt: null,
          lastRawProviderEventSource: null,
          lastStateChangeAt: "2026-04-26T11:59:00.000Z",
          lastVerifiedProgressAt: "2026-04-26T12:01:00.000Z",
          lastVerifiedIdleAt: null,
          lastLivenessProbeAt: null,
          lastLivenessProbeStatus: null,
          lastLivenessProbeSource: null,
          silenceMs: 300_000,
          longSilenceThresholdMs: 300_000,
          processAlive: true,
          queueDepth: 0,
          deferredQueueDepth: 0,
        },
      },
    );

    expect(
      screen.queryByLabelText(
        "Session verified liveness: Verified progress 5m ago",
      ),
    ).toBeNull();
    expect(screen.queryByText("Verified progress 5m")).toBeNull();
    expect(screen.getByText("6m ago")).toBeTruthy();
  });

  it("floats freshness and position age over the composer when compact, even with session status disabled", () => {
    const nowMs = new Date("2026-04-26T12:06:00.000Z").getTime();
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        isCompactStatusMode={true}
        attachmentControl={{ attachmentCount: 0 }}
        statusControl={{
          // Mirrors the parent when sessionStatus is off: inline gates false,
          // but the ages are present and float in compact mode.
          showToolbarStatus: false,
          showLivenessChip: false,
          livenessDisplay: null,
          livenessSummary: null,
          nowMs,
          showLastActivityChip: false,
          showLastActivityPrefix: false,
          lastActivityMs: nowMs - 6 * 60 * 1000,
          lastActivityIsPast: true,
          positionTimestampMs: nowMs - 10 * 60 * 1000,
          showPositionTimestamp: false,
          hasPositionAge: true,
          hasLastActivityAge: true,
        }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    expect(screen.getByText("at 10m ago")).toBeTruthy();
    expect(screen.getByText("6m ago")).toBeTruthy();
    // The decoupled float carries only the ages, never the liveness chip.
    expect(container.querySelector(".composer-liveness-status")).toBeNull();
  });

  it("floats the freshness/position age over the composer even when not compact if session status is disabled", () => {
    // Wide screen + Session Status toggle off: the ages still float (same as
    // narrow), instead of vanishing. Matches the all-widths-when-disabled rule.
    const nowMs = new Date("2026-04-26T12:06:00.000Z").getTime();
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        isCompactStatusMode={false}
        attachmentControl={{ attachmentCount: 0 }}
        statusControl={{
          showToolbarStatus: false,
          showLivenessChip: false,
          livenessDisplay: null,
          livenessSummary: null,
          nowMs,
          showLastActivityChip: false,
          showLastActivityPrefix: false,
          lastActivityMs: nowMs - 6 * 60 * 1000,
          lastActivityIsPast: true,
          positionTimestampMs: nowMs - 10 * 60 * 1000,
          showPositionTimestamp: false,
          hasPositionAge: true,
          hasLastActivityAge: true,
        }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    expect(screen.getByText("at 10m ago")).toBeTruthy();
    expect(screen.getByText("6m ago")).toBeTruthy();
    // Still the floating presentation (not the inline row) and ages only.
    expect(container.querySelector(".status-floats")).toBeTruthy();
    expect(container.querySelector(".composer-liveness-status")).toBeNull();
  });

  it("keeps the liveness chip out of the float even when it would show inline", () => {
    // Compact + sessionStatus on: the parent still asks for the liveness
    // chip, but the float carries only the two ages — floated, the liveness
    // time degrades to a context-free "now" pill over the composer.
    const nowMs = new Date("2026-04-26T12:06:00.000Z").getTime();
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        isCompactStatusMode={true}
        attachmentControl={{ attachmentCount: 0 }}
        statusControl={{
          showToolbarStatus: true,
          showLivenessChip: true,
          livenessDisplay: {
            prefix: "Verified progress",
            timestampMs: nowMs - 30_000,
            tone: "ok",
            title: "status: verified-progressing",
          },
          livenessSummary: "Verified progress now",
          nowMs,
          showLastActivityChip: true,
          showLastActivityPrefix: false,
          lastActivityMs: nowMs - 6 * 60 * 1000,
          lastActivityIsPast: true,
          positionTimestampMs: nowMs - 10 * 60 * 1000,
          showPositionTimestamp: true,
          hasPositionAge: true,
          hasLastActivityAge: true,
        }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    expect(container.querySelector(".composer-liveness-status")).toBeNull();
    expect(screen.queryByText("now")).toBeNull();
    expect(screen.getByText("at 10m ago")).toBeTruthy();
    expect(screen.getByText("6m ago")).toBeTruthy();
  });

  it("shows provider runtime status in the compact status float", () => {
    const nowMs = new Date("2026-04-26T12:06:00.000Z").getTime();
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        isCompactStatusMode={true}
        attachmentControl={{ attachmentCount: 0 }}
        statusControl={{
          showToolbarStatus: true,
          showLivenessChip: false,
          livenessDisplay: null,
          livenessSummary: null,
          providerRuntimeDisplay: {
            label: "Claude rate limited",
            summary: "Claude rate limited - retry at 5:20 PM",
            retryAtMs: nowMs + 60_000,
            tone: "warn",
            title: "Claude rate limited",
          },
          nowMs,
          showLastActivityChip: false,
          showLastActivityPrefix: false,
          lastActivityMs: null,
          lastActivityIsPast: false,
          positionTimestampMs: null,
          showPositionTimestamp: false,
          hasPositionAge: false,
          hasLastActivityAge: false,
        }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    expect(
      screen.getByText("Claude rate limited - retry at 5:20 PM"),
    ).toBeTruthy();
    expect(
      container.querySelector(".composer-provider-runtime-status"),
    ).toBeTruthy();
    expect(container.querySelector(".composer-liveness-status")).toBeNull();
  });

  it("never shows a current position age, even without a freshness label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:06:00.000Z"));

    renderMessageInput(
      vi.fn(() => true),
      {
        // No lastActivityAt: the duplicate-label guard alone would let a
        // current position through; "now" must count as duplicating the
        // (hidden-as-current) freshness.
        positionTimestampMs: Date.now() - 30_000,
      },
    );

    expect(screen.queryByText("at now")).toBeNull();
  });

  it("keeps a send affordance visible when the composer is collapsed", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        collapsed: true,
        placeholder: "messageInputContinueAbove",
      },
    );

    fireEvent.change(textarea, { target: { value: "collapsed send" } });
    fireEvent.click(screen.getByLabelText("toolbarSend"));

    expectSubmission(onSend, "collapsed send", "direct");
  });

  it("keeps a queue affordance visible when the running composer is collapsed", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onQueue,
        collapsed: true,
        placeholder: "messageInputContinueAbove",
      },
    );

    fireEvent.change(textarea, { target: { value: "collapsed queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "collapsed queue", "deferred");
  });

  it("keeps the collapsed composer scrolled to the cursor", async () => {
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        collapsed: true,
      },
    ) as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(textarea, "clientHeight", {
      configurable: true,
      value: 28,
    });

    fireEvent.change(textarea, {
      target: { value: "one\ntwo\nthree\nfour\nfive" },
    });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.keyUp(textarea, { key: "End" });

    await waitFor(() => expect(textarea.scrollTop).toBe(152));
  });

  it("uses the server default busy composer action", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    versionState.version = {
      ...versionState.version,
      clientDefaults: { busyComposerDefaultAction: "queue" },
    };
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        onQueue,
        supportsSteering: true,
      },
    );

    try {
      fireEvent.change(textarea, { target: { value: "default queue" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(onSend).not.toHaveBeenCalled();
      expectSubmission(onQueue, "default queue", "deferred");
    } finally {
      restoreMatchMedia();
    }
  });

  it("keeps session-local Enter swaps ahead of the server default", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    versionState.version = {
      ...versionState.version,
      clientDefaults: { busyComposerDefaultAction: "queue" },
    };
    window.localStorage.setItem("test-draft:enter-action-kind", "steer");
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        onQueue,
        supportsSteering: true,
      },
    );

    try {
      fireEvent.change(textarea, { target: { value: "local steer" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "local steer", "steer");
      expect(onQueue).not.toHaveBeenCalled();
    } finally {
      restoreMatchMedia();
    }
  });

  it("can show the alternate collapsed action", () => {
    versionState.version = {
      ...versionState.version,
      clientDefaults: { collapsedComposerButton: "alternate" },
    };
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onQueue,
        supportsSteering: true,
        collapsed: true,
      },
    );

    fireEvent.change(textarea, { target: { value: "alternate queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "alternate queue", "deferred");
  });

  it("can use the microphone as the collapsed action", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
      clientDefaults: { collapsedComposerButton: "microphone" },
    };

    const textarea = renderMessageInput(
      vi.fn(() => true),
      { collapsed: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "voice" }));

    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
    expect(
      textarea
        .closest("[data-composer-shell='true']")
        ?.getAttribute("data-collapsed-leading-microphone"),
    ).toBe("true");
  });

  it("uses desktop collapsed side space for line count and server mic", () => {
    versionState.version = {
      ...versionState.version,
      voiceBackends: ["ya-grok"],
    };
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        collapsed: true,
      },
    );

    fireEvent.change(textarea, { target: { value: "one\ntwo\nthree" } });

    expect(screen.getByText("3 lines")).toBeTruthy();
    expect(screen.getByRole("button", { name: "voice" })).toBeTruthy();
  });

  it("queues steering-capable messages without adding a mode prefix", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "follow up later", "deferred");
  });

  it("preserves manually typed when-done text as a normal queue message", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, {
      target: { value: "when done, already manual" },
    });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "when done, already manual", "deferred");
  });

  it("Ctrl+Enter queues without adding patient wording by default", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expectSubmission(onQueue, "follow up later", "deferred");
  });

  it("keeps the full-pane toggle available while minimized", () => {
    const textarea = renderMessageInput() as HTMLTextAreaElement;
    const expandButton = screen.getByRole("button", {
      name: "Expand composer",
    });
    const anchoredClassName = expandButton.className;

    expect(expandButton.title).toBe("Expand composer (Ctrl+U)");
    fireEvent.click(
      screen.getByRole("button", { name: "messageInputCollapse" }),
    );
    expect(textarea.rows).toBe(1);
    expect(screen.getByRole("button", { name: "Expand composer" })).toBe(
      expandButton,
    );
    expect(expandButton.className).toBe(anchoredClassName);

    fireEvent.click(expandButton);
    expect(textarea.rows).toBe(3);
    expect(textarea.closest('[data-composer-full-pane="true"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore composer" }).title).toBe(
      "Restore composer (Ctrl+U)",
    );
  });

  it("restores full-pane editing without collapsing to one line", () => {
    let restoreFullPane: (() => void) | undefined;
    const props = {
      onSend: vi.fn(),
      draftKey: "test-draft",
      placeholder: "Message",
      supportsPermissionMode: false,
      supportsThinkingToggle: false,
      onRecallLastSubmission: vi.fn(() => true),
    };
    render(
      <MessageInput
        {...props}
        onFullPaneControlsReady={(controls) => {
          restoreFullPane = controls?.restore;
        }}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "Message",
    ) as HTMLTextAreaElement;

    fireEvent.click(screen.getByRole("button", { name: "Expand composer" }));
    expect(textarea.closest('[data-composer-full-pane="true"]')).toBeTruthy();

    act(() => restoreFullPane?.());
    expect(textarea.closest('[data-composer-full-pane="true"]')).toBeNull();
    expect(textarea.rows).toBe(3);
  });

  it("uses editing-first key semantics in full-pane mode", () => {
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const onProjectQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        onQueue,
        onProjectQueue,
        primaryActionKind: "queue",
        supportsSteering: true,
      },
    );

    fireEvent.change(textarea, { target: { value: "long-form draft" } });
    fireEvent.keyDown(textarea, {
      key: "u",
      ctrlKey: true,
    });

    expect(textarea.closest('[data-composer-full-pane="true"]')).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
    expect(onProjectQueue).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expectSubmission(onSend, "long-form draft", "direct");
    expect(onQueue).not.toHaveBeenCalled();
    expect(onProjectQueue).not.toHaveBeenCalled();
  });

  it("leaves a button-click queue unprefixed and deferred", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "follow up later" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "follow up later", "deferred");
  });

  it("stamps steer-now metadata by default for capable providers", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        supportsSteering: true,
        supportsSteerNow: true,
        onQueue: vi.fn(),
      },
    );

    try {
      expect(
        screen.getByRole<HTMLInputElement>("checkbox", { name: "Steer now" })
          .checked,
      ).toBe(DEFAULT_STEER_NOW_ENABLED);
      fireEvent.change(textarea, { target: { value: "interrupt softly" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "interrupt softly", "steer");
      expect(onSend.mock.calls.at(-1)?.[1]).toMatchObject({
        steerNow: true,
      });
    } finally {
      restoreMatchMedia();
    }
  });

  it("honors an explicit steer-now default override", () => {
    versionState.version = {
      ...versionState.version,
      clientDefaults: { steerNowDefault: false },
    };
    const restoreMatchMedia = installDesktopMatchMedia();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        supportsSteering: true,
        supportsSteerNow: true,
        onQueue: vi.fn(),
      },
    );

    try {
      expect(
        screen.getByRole<HTMLInputElement>("checkbox", { name: "Steer now" })
          .checked,
      ).toBe(false);
      fireEvent.change(textarea, { target: { value: "wait for boundary" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "wait for boundary", "steer");
      expect(onSend.mock.calls.at(-1)?.[1]).not.toHaveProperty("steerNow");
    } finally {
      restoreMatchMedia();
    }
  });

  it("routes a queue-only primary button through onSend", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        primaryActionKind: "queue",
      },
    );

    const primaryButton = screen.getByLabelText("toolbarQueueLabel");
    expect(primaryButton.getAttribute("data-tooltip")).toContain(
      "toolbarQueueTooltip",
    );

    fireEvent.change(textarea, { target: { value: "claude queue click" } });
    fireEvent.click(primaryButton);

    expectSubmission(onSend, "claude queue click", "deferred");
  });

  it("routes Enter through a queue-only primary action", () => {
    const restoreMatchMedia = installDesktopMatchMedia();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        primaryActionKind: "queue",
      },
    );

    try {
      fireEvent.change(textarea, { target: { value: "claude queue enter" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expectSubmission(onSend, "claude queue enter", "deferred");
    } finally {
      restoreMatchMedia();
    }
  });

  it("keeps non-steering queue text unchanged", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onQueue },
    );

    fireEvent.change(textarea, { target: { value: "plain queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "plain queue", "deferred");
  });

  it("uses patient intent when the patient-queue default is enabled", () => {
    versionState.version = {
      ...versionState.version,
      clientDefaults: { patientQueueDefault: true },
    };
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      { onQueue },
    );

    fireEvent.change(textarea, { target: { value: "claude patient queue" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expectSubmission(onQueue, "claude patient queue", "patient");
  });

  it("uses Ctrl+Enter for Project Queue when that action is visible", () => {
    versionState.version = {
      ...versionState.version,
      clientDefaults: { patientQueueDefault: true },
    };
    const onQueue = vi.fn();
    const onProjectQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
        onProjectQueue,
        onProjectQueueNewSession,
      },
    );

    fireEvent.change(textarea, { target: { value: "project quiet later" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expectSubmission(onProjectQueue, "project quiet later", "deferred");
    expect(onProjectQueueNewSession).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
  });

  it("does not bind Ctrl+Enter to the Project Queue new-session action", () => {
    const onQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
        onProjectQueueNewSession,
      },
    );

    fireEvent.change(textarea, { target: { value: "stay in this session" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expectSubmission(onQueue, "stay in this session", "deferred");
    expect(onProjectQueueNewSession).not.toHaveBeenCalled();
  });

  it("falls back to patient queue when the Project Queue shortcut is disabled", () => {
    versionState.version = {
      ...versionState.version,
      clientDefaults: {
        patientQueueDefault: true,
        projectQueueCtrlEnterEnabled: false,
      },
    };
    const onQueue = vi.fn();
    const onProjectQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
        onProjectQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "patient fallback" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onProjectQueue).not.toHaveBeenCalled();
    expectSubmission(onQueue, "patient fallback", "patient");
  });

  it("does not steal Ctrl+Enter from queue when Project Queue is unsupported", () => {
    versionState.version = {
      ...versionState.version,
      capabilities: [VOICE_INPUT_CAPABILITY],
      clientDefaults: { patientQueueDefault: true },
    };
    const onQueue = vi.fn();
    const onProjectQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
        onProjectQueue,
      },
    );

    fireEvent.change(textarea, { target: { value: "unsupported fallback" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onProjectQueue).not.toHaveBeenCalled();
    expectSubmission(onQueue, "unsupported fallback", "patient");
  });

  it("keeps queue available when the primary steer action downgrades", () => {
    const onQueue = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        supportsSteering: true,
        onQueue,
        primaryActionKind: "queue",
      },
    );

    fireEvent.change(textarea, { target: { value: "queue fallback" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expect(screen.getAllByLabelText("toolbarQueueLabel")).toHaveLength(1);
    expectSubmission(onQueue, "queue fallback", "deferred");
  });

  it("routes the primary downgraded steer action to queue", () => {
    const onQueue = vi.fn();
    const onSend = vi.fn();
    const textarea = renderMessageInput(
      vi.fn(() => true),
      {
        onSend,
        supportsSteering: true,
        onQueue,
        primaryActionKind: "queue",
      },
    );

    fireEvent.change(textarea, { target: { value: "queue from primary" } });
    fireEvent.click(screen.getByLabelText("toolbarQueueLabel"));

    expect(onSend).not.toHaveBeenCalled();
    expectSubmission(onQueue, "queue from primary", "deferred");
  });

  it("routes the explicit project queue action with deferred metadata", () => {
    const onProjectQueue = vi.fn();
    const textarea = renderMessageInput(vi.fn(), { onProjectQueue });

    fireEvent.change(textarea, { target: { value: "project-wide later" } });
    expect(
      screen
        .getByRole("button", { name: "Queue for Project Queue" })
        .getAttribute("title"),
    ).toBe("Send after all sessions in this project are idle\nCtrl+Enter");
    fireEvent.click(
      screen.getByRole("button", { name: "Queue for Project Queue" }),
    );

    expectSubmission(onProjectQueue, "project-wide later", "deferred");
  });

  it("uses the selected speech prefix and cue for Project Queue", async () => {
    window.localStorage.setItem(UI_KEYS.speechAsrAttributionMs, "1000");
    window.localStorage.setItem(UI_KEYS.speechMessagePrefixMode, "custom");
    window.localStorage.setItem(
      UI_KEYS.speechMessageCustomPrefix,
      "Needs review:",
    );
    const onProjectQueue = vi.fn();
    renderMessageInput(vi.fn(), { onProjectQueue });

    voiceButtonState.isListening = true;
    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("project-wide dictation");
    });

    const projectQueueButton = screen.getByRole("button", {
      name: /Queue for Project Queue.*Needs review:/,
    });
    expect(projectQueueButton.textContent).toContain("Needs review:");
    expect(
      screen.getByRole("button", { name: /toolbarSend.*Needs review:/ }),
    ).toBeDefined();

    fireEvent.click(projectQueueButton);
    expect(onProjectQueue).not.toHaveBeenCalled();

    act(() => {
      voiceButtonState.isListening = false;
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onTranscript?.("settled backend words");
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    await waitFor(() => {
      expectSubmission(
        onProjectQueue,
        "Needs review: project-wide dictation",
        "deferred",
      );
      expect(screen.queryByText("Needs review:")).toBeNull();
    });
  });

  it("routes the explicit Project Queue new-session action", () => {
    const onProjectQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onProjectQueue,
      onProjectQueueNewSession,
    });

    fireEvent.change(textarea, { target: { value: "start separately later" } });
    const button = screen.getByRole("button", {
      name: "Queue as new session for Project Queue",
    });

    expect(button.getAttribute("title")).toBe(
      "Start a new session after all sessions in this project are idle",
    );
    fireEvent.click(button);

    expectSubmission(
      onProjectQueueNewSession,
      "start separately later",
      "deferred",
    );
    expect(onProjectQueue).not.toHaveBeenCalled();
  });

  it("shows only the Project Queue new-session action when current-session queueing is unavailable", () => {
    const onProjectQueueNewSession = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onProjectQueueNewSession,
    });

    fireEvent.change(textarea, { target: { value: "new work" } });

    expect(
      screen.queryByRole("button", { name: "Queue for Project Queue" }),
    ).toBe(null);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Queue as new session for Project Queue",
      }),
    );
    expectSubmission(onProjectQueueNewSession, "new work", "deferred");
  });

  it("hides the project queue action without server capability", () => {
    versionState.version = {
      ...versionState.version,
      capabilities: [VOICE_INPUT_CAPABILITY],
    };
    const onProjectQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();
    const textarea = renderMessageInput(vi.fn(), {
      onProjectQueue,
      onProjectQueueNewSession,
    });

    fireEvent.change(textarea, { target: { value: "project-wide later" } });

    expect(
      screen.queryByRole("button", { name: "Queue for Project Queue" }),
    ).toBe(null);
    expect(
      screen.queryByRole("button", {
        name: "Queue as new session for Project Queue",
      }),
    ).toBe(null);
  });

  it("keeps the project queue toolbar action hidden by visibility", () => {
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{ ...toolbarVisibility, projectQueue: false }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "send",
            primaryActionLabel: "Send",
            tooltip: "Send",
            icon: "↑",
          },
          projectQueue: {
            onProjectQueue: vi.fn(),
            canSend: true,
            tooltip: "Project Queue",
          },
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Queue for Project Queue" }),
    ).toBe(null);
  });

  it("renders the project queue toolbar action when visible", () => {
    const onProjectQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{ ...toolbarVisibility, projectQueue: true }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "send",
            primaryActionLabel: "Send",
            tooltip: "Send",
            icon: "↑",
          },
          projectQueue: {
            onProjectQueue,
            onProjectQueueNewSession,
            canSend: true,
            tooltip: "Project Queue",
            newSessionTooltip: "New-session Project Queue",
          },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Queue for Project Queue" }),
    );

    expect(onProjectQueue).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", {
        name: "Queue as new session for Project Queue",
      }),
    ).toBe(null);
    expect(onProjectQueueNewSession).not.toHaveBeenCalled();
  });

  it("renders the new-session Project Queue shortcut only when opted in", () => {
    const onProjectQueue = vi.fn();
    const onProjectQueueNewSession = vi.fn();
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{
          ...toolbarVisibility,
          projectQueue: false,
          projectQueueNewSessionShortcut: true,
        }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "send",
            primaryActionLabel: "Send",
            tooltip: "Send",
            icon: "↑",
          },
          projectQueue: {
            onProjectQueue,
            onProjectQueueNewSession,
            canSend: true,
            tooltip: "Project Queue",
            newSessionTooltip: "New-session Project Queue",
          },
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Queue for Project Queue" }),
    ).toBe(null);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Queue as new session for Project Queue",
      }),
    );
    expect(onProjectQueue).not.toHaveBeenCalled();
    expect(onProjectQueueNewSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the render mode toolbar action hidden by visibility", () => {
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{ ...toolbarVisibility, renderMode: false }}
        attachmentControl={{ attachmentCount: 0 }}
        renderModeControl={{
          state: "rendered",
          title: "Show source",
          onToggle: vi.fn(),
        }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Show source" })).toBe(null);
  });

  it("renders context usage as passive status chrome", () => {
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{ ...toolbarVisibility, contextUsage: true }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          contextUsage: {
            inputTokens: 42_000,
            percentage: 42,
            contextWindow: 100_000,
          },
        }}
      />,
    );

    const indicator = container.querySelector(".context-usage-indicator");
    expect(indicator).toBeTruthy();
    expect(indicator?.closest("button")).toBe(null);
  });

  it("renders the active waveform behind the toolbar's left and center span", () => {
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        speechWaveformActive
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    const toolbar = container.querySelector(".message-input-toolbar");
    const waveform = container.querySelector(".composer-speech-waveform");
    expect(waveform).toBeTruthy();
    expect(
      waveform?.parentElement?.classList.contains("message-input-left"),
    ).toBe(false);
    expect(
      waveform?.parentElement?.querySelector(".message-input-left"),
    ).toBeTruthy();
    expect(toolbar?.contains(waveform)).toBe(true);
    expect(
      toolbar?.getAttribute("data-waveform-button-background-opacity"),
    ).toBe("70");
    expect(
      (toolbar as HTMLElement).style.getPropertyValue(
        "--waveform-control-surface-opacity",
      ),
    ).toBe("70%");
  });

  it("renders the file viewer controller in the toolbar center gap", async () => {
    const close = vi.fn();
    const minimize = vi.fn();
    const restore = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{
          ...toolbarVisibility,
          contextUsage: true,
          microphone: true,
        }}
        fileViewerController={{
          close,
          filePath: "/workspace/docs/guide.md",
          id: "viewer-1",
          kind: "file",
          sessionId: "session-1",
          label: "/workspace/docs/guide.md:12",
          lineSuffix: ":12",
          minimize,
          minimized: true,
          onClose: close,
          restore,
        }}
        speechWaveformActive
        waveformButtonBackgroundOpacityPercent={35}
        speechControl={{
          showMethodSelector: false,
          methodOptions: [],
          selectedMethod: "browser-native",
          onMethodChange: vi.fn(),
          voiceButton: { kind: "preview" },
        }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          contextUsage: {
            inputTokens: 42_000,
            percentage: 42,
            contextWindow: 100_000,
          },
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "send",
            primaryActionLabel: "Send",
            tooltip: "Send",
            icon: "↑",
          },
        }}
      />,
    );

    const controller = screen.getByRole("group", {
      name: "File viewer: /workspace/docs/guide.md:12",
    });
    const slot = container.querySelector(
      '[data-file-viewer-controller-slot="true"]',
    );
    expect(slot?.parentElement?.parentElement).toBe(
      container.querySelector(".message-input-toolbar"),
    );
    expect(slot?.previousElementSibling?.classList).toContain(
      "message-input-left",
    );
    expect(controller.querySelector("bdi")?.textContent).toBe(
      "/workspace/docs/guide.md",
    );
    expect(controller.textContent).toContain(":12");
    expect(
      (controller as HTMLElement).style.getPropertyValue(
        "--waveform-control-surface-opacity",
      ),
    ).toBe("35%");
    const inlineContext = container.querySelector(
      ".message-input-actions .context-toolbar-control",
    );
    expect(inlineContext?.classList).toContain("composer-bottom-overflow-late");
    expect(inlineContext?.classList).not.toContain(
      "composer-bottom-overflow-pinned",
    );
    expect(
      screen.getByRole("button", { name: "voiceInputStartLabel" }).classList,
    ).not.toContain("composer-bottom-overflow-late");
    expect(
      screen.getByRole("button", { name: "Send" }).classList,
    ).not.toContain("composer-bottom-overflow-late");
    const restoreButton = screen.getByRole("button", {
      name: "Restore file viewer: /workspace/docs/guide.md:12",
    });
    fireEvent.contextMenu(restoreButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/workspace/docs/guide.md");
    });
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(restoreButton);
    expect(restore).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Close file viewer: /workspace/docs/guide.md:12",
      }),
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(minimize).not.toHaveBeenCalled();
  });

  it("parks an open file viewer before running a toolbar action", () => {
    const minimize = vi.fn();
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{ ...toolbarVisibility, microphone: true }}
        fileViewerController={{
          close: vi.fn(),
          filePath: "/workspace/docs/guide.md",
          id: "viewer-1",
          kind: "file",
          sessionId: "session-1",
          label: "/workspace/docs/guide.md:12",
          lineSuffix: ":12",
          minimize,
          minimized: false,
          onClose: vi.fn(),
          restore: vi.fn(),
        }}
        speechControl={{
          showMethodSelector: false,
          methodOptions: [],
          selectedMethod: "browser-native",
          onMethodChange: vi.fn(),
          voiceButton: {
            kind: "live",
            ref: { current: null },
            onTranscript: () => undefined,
            onInterimTranscript: vi.fn(),
            speechMethod: "browser-native",
          },
        }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "voice" }));

    expect(minimize).toHaveBeenCalledTimes(1);
    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
    expect(minimize.mock.invocationCallOrder[0]).toBeLessThan(
      mockVoiceToggle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("renders activity viewer minimize and close controls in the same dock", () => {
    const close = vi.fn();
    const minimize = vi.fn();
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        fileViewerController={{
          close,
          content: "output",
          id: "activity-1",
          kind: "panel",
          sessionId: "session-1",
          label: "Bash Command",
          briefLabel: "Bash",
          minimize,
          minimized: false,
          onClose: close,
          restore: vi.fn(),
          title: "Bash Command",
        }}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Minimize detail view: Bash Command",
      }),
    );
    expect(minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Close detail view: Bash Command",
      }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses only the custom tooltip on the primary send action", () => {
    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "steer",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "steer",
            primaryActionLabel: "Steer current turn",
            tooltip: "Steer current turn\nEnter",
            icon: "↗",
          },
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Steer current turn" });
    expect(button.getAttribute("data-tooltip")).toBe(
      "Steer current turn\nEnter",
    );
    expect(button.getAttribute("title")).toBe(null);
    expect(container.querySelector(".send-button-with-help")).toBe(button);
  });

  it("uses only the browser title on the primary send action in native mode", () => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={toolbarVisibility}
        attachmentControl={{ attachmentCount: 0 }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "steer",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "steer",
            primaryActionLabel: "Steer current turn",
            tooltip: "Steer current turn\nEnter",
            icon: "↗",
          },
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Steer current turn" });
    expect(button.getAttribute("title")).toBe("Steer current turn\nEnter");
    expect(button.getAttribute("data-tooltip")).toBeNull();
  });

  it("opens a bottom-row overflow strip for lower-priority controls", async () => {
    const onRenderToggle = vi.fn();
    const onBrowserDebugToggle = vi.fn();
    const onBrowserDebugReactivate = vi.fn();
    const onBrowserDebugReload = vi.fn();
    const onNudgeClick = vi.fn();
    const setShortcutsOpen = vi.fn();
    const onBtwClick = vi.fn();
    const onToggleSteerNow = vi.fn();
    const onProjectQueue = vi.fn();

    const { container } = render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{
          ...toolbarVisibility,
          thinkingToggle: false,
          renderMode: true,
          browserDebug: true,
          shortcutsHelp: true,
          contextUsage: true,
          btw: true,
          nudge: true,
          projectQueue: true,
        }}
        priority={{
          ...DEFAULT_SESSION_TOOLBAR_PRIORITY,
          contextUsage: "first",
          browserDebug: "first",
          btw: "first",
          steerNow: "first",
          projectQueue: "first",
        }}
        attachmentControl={{ attachmentCount: 0 }}
        renderModeControl={{
          state: "mixed",
          title: "Toggle rendered output",
          onToggle: onRenderToggle,
        }}
        browserDebugControl={{
          active: true,
          connected: true,
          remainingFraction: 0.5,
          performanceLabel: "max 84ms · long 2",
          title: "Disable browser debugging",
          onToggle: onBrowserDebugToggle,
          onReactivate: onBrowserDebugReactivate,
          onReload: onBrowserDebugReload,
        }}
        nudgeControl={{
          enabled: true,
          title: "Pulse after quiet",
          onClick: onNudgeClick,
          onContextMenu: vi.fn(),
          onTouchStart: vi.fn(),
          onTouchEnd: vi.fn(),
          onClearTouch: vi.fn(),
        }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            setShortcutsOpen as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{
          contextUsage: {
            inputTokens: 42_000,
            percentage: 42,
            contextWindow: 100_000,
          },
          btw: {
            onClick: onBtwClick,
            pressed: false,
            mode: "start",
            title: "Start /btw aside",
          },
          projectQueue: {
            onProjectQueue,
            canSend: true,
            tooltip: "Queue for Project Queue",
          },
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "send",
            primaryActionLabel: "Send",
            tooltip: "Send",
            icon: "↑",
            showSteerNowMode: true,
            steerNowEnabled: false,
            onToggleSteerNow,
          },
        }}
      />,
    );

    const overflow = screen.getByRole("button", {
      name: "More toolbar controls",
    });
    expect(screen.getByText("max 84ms · long 2")).toBeTruthy();
    expect(overflow.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();

    await waitFor(() =>
      expect(
        container.querySelector('[data-browser-debug-context-menu="true"]'),
      ).toBeTruthy(),
    );
    fireEvent.contextMenu(
      container.querySelector('[data-browser-debug-context-menu="true"]')!,
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Reload app code (keep debugging)",
      }),
    );
    expect(onBrowserDebugReload).toHaveBeenCalledTimes(1);
    expect(onBrowserDebugReactivate).not.toHaveBeenCalled();

    fireEvent.click(overflow);

    expect(overflow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Toggle rendered output").at(-1)!);
    fireEvent.click(
      screen.getAllByLabelText("Disable browser debugging").at(-1)!,
    );
    fireEvent.click(screen.getAllByLabelText("Pulse after quiet").at(-1)!);
    fireEvent.click(
      screen.getAllByLabelText("Session keyboard shortcuts").at(-1)!,
    );
    fireEvent.click(screen.getAllByLabelText("Start /btw aside").at(-1)!);
    fireEvent.click(screen.getAllByLabelText("Steer now").at(-1)!);
    fireEvent.click(
      screen.getAllByLabelText("Queue for Project Queue").at(-1)!,
    );

    expect(onRenderToggle).toHaveBeenCalledTimes(1);
    expect(onBrowserDebugToggle).toHaveBeenCalledTimes(1);
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
    expect(setShortcutsOpen).toHaveBeenCalledTimes(1);
    expect(onBtwClick).toHaveBeenCalledTimes(1);
    expect(onToggleSteerNow).toHaveBeenCalledTimes(1);
    expect(onProjectQueue).toHaveBeenCalledTimes(1);
    expect(
      container.querySelectorAll(
        ".composer-bottom-overflow-menu .context-toolbar-control",
      ),
    ).toHaveLength(1);
  });

  it("renders synthetic done with its centered transparent control style", () => {
    const onDone = vi.fn();
    render(
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{ ...toolbarVisibility, syntheticDone: true }}
        attachmentControl={{ attachmentCount: 0 }}
        doneControl={{ onDone, title: "Close focused aside" }}
        shortcutsControl={{
          open: false,
          isearchScope: null,
          setOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
          settingsOpen: false,
          setSettingsOpen:
            vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
          hasDualActions: false,
          enterActionKind: "send",
          canSwapEnterAction: false,
          queueShortcutLabel: "Queue while agent runs",
        }}
        actionsControl={{}}
      />,
    );

    const button = screen.getByTestId("synthetic-done-toolbar-button");
    expect(button.className).toContain("doneButton");
    expect(button.getAttribute("aria-label")).toBe("Close focused aside");
    fireEvent.click(button);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("tracks toolbar overflow layout membership in a pure signature", () => {
    const baseInput: ComposerToolbarOverflowLayoutSignatureInput = {
      modeSelector: "first",
      attachments: "first",
      slashMenu: "mid",
      thinkingToggle: "mid",
      renderMode: "last",
      conversationView: "last",
      browserDebug: "last",
      nudge: "last",
      syntheticDone: "off",
      sessionStatus: "pin",
      shortcutsHelp: "last",
      contextUsage: "pin",
      btw: "pin",
      steerNow: "pin",
      projectQueue: "pin",
      projectQueueNewSessionShortcut: "off",
      microphone: "live",
      waveform: true,
      send: "send",
      queue: "off",
      alternate: false,
      stop: false,
      pending: "off",
    };

    const signature = getComposerToolbarOverflowLayoutSignature(baseInput);

    expect(signature).toContain("modeSelector:first");
    expect(signature).toContain("attachments:first");
    expect(
      getComposerToolbarOverflowLayoutSignature({
        ...baseInput,
        attachments: "off",
      }),
    ).not.toBe(signature);
    expect(
      getComposerToolbarOverflowLayoutSignature({
        ...baseInput,
        queue: "send:true:false",
      }),
    ).not.toBe(signature);
  });

  it("relaxes bottom-row overflow when visible controls shrink", () => {
    const originalResizeObserver = window.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const currentTier = (
      element: Element,
    ): "none" | "early" | "medium" | "late" => {
      const toolbar = element.closest(".message-input-toolbar");
      if (!toolbar) return "none";
      if (toolbar.classList.contains("overflow-tier-late")) return "late";
      if (toolbar.classList.contains("overflow-tier-medium")) return "medium";
      if (toolbar.classList.contains("overflow-tier-early")) return "early";
      return "none";
    };
    const inlineHidden = (element: Element): boolean => {
      if (!element.classList.contains("composer-bottom-overflow-inline")) {
        return false;
      }
      const tier = currentTier(element);
      return (
        (element.classList.contains("composer-bottom-overflow-early") &&
          tier !== "none") ||
        (element.classList.contains("composer-bottom-overflow-medium") &&
          (tier === "medium" || tier === "late")) ||
        (element.classList.contains("composer-bottom-overflow-late") &&
          tier === "late")
      );
    };
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const hidden = inlineHidden(element);
      return {
        display: hidden ? "none" : "block",
        position: "static",
        columnGap: "0px",
        gap: "0px",
      } as CSSStyleDeclaration;
    });
    const rect = (width: number): DOMRect =>
      ({
        top: 0,
        bottom: 32,
        left: 0,
        right: width,
        width,
        height: 32,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getToolbarTestRect(this: HTMLElement) {
        if (this.classList.contains("message-input-toolbar")) return rect(100);
        if (
          this.classList.contains("message-input-left") ||
          this.classList.contains("message-input-actions")
        ) {
          return rect(1);
        }
        if (this.classList.contains("composer-bottom-overflow"))
          return rect(24);
        if (this.classList.contains("attach-button")) return rect(80);
        if (this.classList.contains("send-button-with-help")) return rect(40);
        if (
          this.classList.contains("composer-bottom-overflow-inline") &&
          this.querySelector(".mode-selector-container")
        ) {
          return rect(40);
        }
        return rect(0);
      },
    );

    const shortcutsControl: MessageInputToolbarViewProps["shortcutsControl"] = {
      open: false,
      isearchScope: null,
      setOpen:
        vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setOpen"],
      settingsOpen: false,
      setSettingsOpen:
        vi.fn() as unknown as MessageInputToolbarViewProps["shortcutsControl"]["setSettingsOpen"],
      hasDualActions: false,
      enterActionKind: "send",
      canSwapEnterAction: false,
      queueShortcutLabel: "Queue while agent runs",
    };
    const renderMeasuredToolbar = (showAttachments: boolean) => (
      <MessageInputToolbarView
        t={toolbarT}
        visibility={{
          ...toolbarVisibility,
          modeSelector: true,
          attachments: showAttachments,
          steerNow: false,
          thinkingToggle: false,
        }}
        modeControl={{
          mode: "default",
          onModeChange: vi.fn(),
          modes: ["default"],
        }}
        attachmentControl={{ attachmentCount: 0, canAttach: true }}
        shortcutsControl={shortcutsControl}
        actionsControl={{
          send: {
            onSend: vi.fn(),
            canSend: true,
            primaryActionKind: "send",
            primaryActionLabel: "Send",
            tooltip: "Send",
            icon: "↑",
          },
        }}
      />
    );
    const resizeEntry = (target: Element, width: number): ResizeObserverEntry =>
      ({
        target,
        contentRect: { width } as DOMRectReadOnly,
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      }) as ResizeObserverEntry;

    try {
      const { container, rerender } = render(renderMeasuredToolbar(true));
      const toolbar = () =>
        container.querySelector(".message-input-toolbar") as HTMLElement;
      act(() => {
        resizeCallback?.([resizeEntry(toolbar(), 100)], {} as ResizeObserver);
      });
      expect(toolbar().classList.contains("overflow-tier-early")).toBe(true);

      rerender(renderMeasuredToolbar(false));
      act(() => {
        resizeCallback?.([resizeEntry(toolbar(), 100)], {} as ResizeObserver);
      });

      expect(toolbar().classList.contains("overflow-tier-none")).toBe(true);
    } finally {
      Object.defineProperty(window, "ResizeObserver", {
        configurable: true,
        value: originalResizeObserver,
      });
    }
  });
});

describe("MessageInput bang commands", () => {
  let restoreMatchMedia: () => void;

  beforeEach(() => {
    restoreMatchMedia = installDesktopMatchMedia();
    window.localStorage.clear();
  });

  afterEach(() => {
    restoreMatchMedia();
    cleanup();
    vi.restoreAllMocks();
  });

  // Completion fetch result shape: token candidates plus the global
  // command-history matches the client ranks ahead of them.
  const completionsResult = (
    completions: string[],
    history: string[] = [],
  ) => ({
    completions,
    history,
  });

  function bangSupport(
    overrides: Partial<{
      onRun: ReturnType<typeof vi.fn>;
      fetchCompletions: ReturnType<typeof vi.fn>;
      history: string[];
    }> = {},
  ) {
    return {
      onRun: overrides.onRun ?? vi.fn(),
      fetchCompletions:
        overrides.fetchCompletions ?? vi.fn(async () => completionsResult([])),
      history: overrides.history ?? [],
    };
  }

  it("routes !! drafts to onRun instead of onSend", async () => {
    const onSend = vi.fn();
    const support = bangSupport();
    const textarea = renderMessageInput(undefined, {
      onSend,
      bangSupport: support,
    });
    fireEvent.change(textarea, { target: { value: "!!git status" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(support.onRun).toHaveBeenCalledWith("git status");
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("sends an attachment-only draft when bang commands are available", () => {
    const onSend = vi.fn();
    const support = bangSupport();
    const textarea = renderMessageInput(undefined, {
      onSend,
      bangSupport: support,
      attachments: [TEST_ATTACHMENT],
    });

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ deliveryIntent: "direct" }),
    );
    expect(support.onRun).not.toHaveBeenCalled();
  });

  it("keeps a bang draft when the server rejects the run", async () => {
    const onSend = vi.fn();
    const support = bangSupport({
      onRun: vi.fn(async () => {
        throw new Error("route unavailable");
      }),
    });
    const textarea = renderMessageInput(undefined, {
      onSend,
      bangSupport: support,
    });
    fireEvent.change(textarea, { target: { value: "!!git status" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(support.onRun).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe("!!git status");
  });

  it("strips one leading space as the literal-!! escape and sends", () => {
    const onSend = vi.fn();
    const textarea = renderMessageInput(undefined, {
      onSend,
      bangSupport: bangSupport(),
    });
    fireEvent.change(textarea, { target: { value: " !!not a command" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalled();
    expect(onSend.mock.calls[0]?.[0]).toBe("!!not a command");
  });

  it("fetches typing-triggered completions with token, kind, and line", async () => {
    const fetchCompletions = vi.fn(async () =>
      completionsResult(["gitalike", "gizmo"]),
    );
    const support = bangSupport({ fetchCompletions });
    const textarea = renderMessageInput(undefined, {
      bangSupport: support,
    });
    fireEvent.change(textarea, { target: { value: "!!gi" } });
    await waitFor(() =>
      expect(fetchCompletions).toHaveBeenCalledWith("gi", "command", "gi"),
    );
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "gizmo" })).toBeTruthy(),
    );
  });

  it("applies a single Tab completion immediately", async () => {
    const fetchCompletions = vi.fn(async () => completionsResult(["gitalike"]));
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ fetchCompletions }),
    });
    fireEvent.change(textarea, { target: { value: "!!gita" } });
    fireEvent.keyDown(textarea, { key: "Tab" });
    await waitFor(() =>
      expect((textarea as HTMLTextAreaElement).value).toBe("!!gitalike "),
    );
  });

  it("discards a Tab completion after the draft changes", async () => {
    let resolveCompletions: (result: {
      completions: string[];
      history: string[];
    }) => void = () => {};
    const fetchCompletions = vi.fn(
      () =>
        new Promise<{ completions: string[]; history: string[] }>((resolve) => {
          resolveCompletions = resolve;
        }),
    );
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ fetchCompletions }),
    });
    fireEvent.change(textarea, { target: { value: "!!gi" } });
    fireEvent.keyDown(textarea, { key: "Tab" });
    fireEvent.change(textarea, { target: { value: "!!git status" } });
    resolveCompletions(completionsResult(["gitalike"]));

    await waitFor(() => expect(fetchCompletions).toHaveBeenCalled());
    expect((textarea as HTMLTextAreaElement).value).toBe("!!git status");
  });

  it("recalls bang history with Ctrl+ArrowUp", () => {
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ history: ["git status", "ls"] }),
    });
    fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
    expect((textarea as HTMLTextAreaElement).value).toBe("!!git status");
    fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
    expect((textarea as HTMLTextAreaElement).value).toBe("!!ls");
    fireEvent.keyDown(textarea, { key: "ArrowDown", ctrlKey: true });
    expect((textarea as HTMLTextAreaElement).value).toBe("!!git status");
  });

  it("does not treat an attachment-only draft as empty bang history", () => {
    const textarea = renderMessageInput(undefined, {
      attachments: [TEST_ATTACHMENT],
      bangSupport: bangSupport({ history: ["git status"] }),
    }) as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });

    expect(textarea.value).toBe("");
  });

  const bangMenuLabels = () =>
    Array.from(
      document.querySelectorAll(".bang-completion-menu .slash-command-item"),
    ).map((el) => el.textContent);

  it("ranks global history above token candidates in the menu", async () => {
    const fetchCompletions = vi.fn(async () =>
      completionsResult(["gitalike"], ["git status", "git log"]),
    );
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ fetchCompletions }),
    });
    fireEvent.change(textarea, { target: { value: "!!git" } });
    await waitFor(() =>
      expect(bangMenuLabels()).toEqual(["git status", "git log", "gitalike"]),
    );
    // History rows carry the distinguishing class; candidates do not.
    const items = document.querySelectorAll(
      ".bang-completion-menu .slash-command-item",
    );
    expect(items[0]?.classList.contains("bang-history-item")).toBe(true);
    expect(items[2]?.classList.contains("bang-history-item")).toBe(false);
  });

  it("applies a highlighted history row as the whole !! body", async () => {
    const fetchCompletions = vi.fn(async () =>
      completionsResult(["gitalike"], ["git status", "git log"]),
    );
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ fetchCompletions }),
    });
    fireEvent.change(textarea, { target: { value: "!!git" } });
    await waitFor(() =>
      expect(bangMenuLabels()).toEqual(["git status", "git log", "gitalike"]),
    );
    // Tab accepts the highlighted (first = history) row, replacing the body.
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect((textarea as HTMLTextAreaElement).value).toBe("!!git status");
    // The menu closes after a whole-line history apply.
    expect(document.querySelector(".bang-completion-menu")).toBeNull();
  });

  it("applies a token candidate by replacing only the token", async () => {
    const fetchCompletions = vi.fn(async () =>
      completionsResult(["gitalike", "gitother"], ["git status"]),
    );
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ fetchCompletions }),
    });
    fireEvent.change(textarea, { target: { value: "!!git" } });
    await waitFor(() =>
      expect(bangMenuLabels()).toEqual(["git status", "gitalike", "gitother"]),
    );
    // Move selection down to the first token candidate ("gitalike").
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect((textarea as HTMLTextAreaElement).value).toBe("!!gitalike ");
  });

  it("opens the menu on Tab when only history matches (no auto-apply)", async () => {
    let resolve: (result: {
      completions: string[];
      history: string[];
    }) => void = () => {};
    const fetchCompletions = vi.fn(
      () =>
        new Promise<{ completions: string[]; history: string[] }>((r) => {
          resolve = r;
        }),
    );
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ fetchCompletions }),
    });
    fireEvent.change(textarea, { target: { value: "!!gi" } });
    fireEvent.keyDown(textarea, { key: "Tab" });
    resolve(completionsResult([], ["git status", "git log"]));
    await waitFor(() =>
      expect(bangMenuLabels()).toEqual(["git status", "git log"]),
    );
    // Whole-line history never auto-applies on Tab; the draft is unchanged.
    expect((textarea as HTMLTextAreaElement).value).toBe("!!gi");
  });

  it("keeps Escape-dismiss and re-show-on-typing for history matches", async () => {
    const fetchCompletions = vi.fn(async () =>
      completionsResult([], ["git status"]),
    );
    const textarea = renderMessageInput(undefined, {
      bangSupport: bangSupport({ fetchCompletions }),
    });
    fireEvent.change(textarea, { target: { value: "!!gi" } });
    await waitFor(() =>
      expect(document.querySelector(".bang-completion-menu")).toBeTruthy(),
    );
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(document.querySelector(".bang-completion-menu")).toBeNull();
    // Typing further changes the query key, so the menu is eligible again.
    fireEvent.change(textarea, { target: { value: "!!git" } });
    await waitFor(() =>
      expect(document.querySelector(".bang-completion-menu")).toBeTruthy(),
    );
  });

  it("handles enabled /done locally across a queued primary action", () => {
    const onDone = vi.fn();
    const onSend = vi.fn();
    const onQueue = vi.fn();
    const textarea = renderMessageInput(undefined, {
      onDone,
      onSend,
      onQueue,
      isRunning: true,
      primaryActionKind: "queue",
    });

    fireEvent.change(textarea, { target: { value: "/done" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });
});
