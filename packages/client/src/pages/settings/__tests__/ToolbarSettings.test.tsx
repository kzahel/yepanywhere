// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
  SYNTHETIC_DONE_COMMAND_CAPABILITY,
} from "@yep-anywhere/shared";
import {
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
} from "@yep-anywhere/shared";
import {
  DEFAULT_CONVERSATION_VIEW_TURN_LIMIT,
  setConversationViewTurnLimit,
} from "../../../hooks/useConversationView";
import {
  DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
  setWaveformButtonBackgroundOpacityPercent,
} from "../../../hooks/useWaveformButtonBackgroundOpacity";
import { ToolbarSettings } from "../ToolbarSettings";
import { SettingsSearchScopeProvider } from "../SettingsSearchContext";

const state = vi.hoisted(() => {
  const defaultPresence = {
    modeSelector: "first",
    steerNow: "pin",
    attachments: "first",
    slashMenu: "mid",
    thinkingToggle: "mid",
    renderMode: "hidden",
    conversationView: "last",
    browserDebug: "hidden",
    microphone: "pin",
    waveform: "pin",
    shortcutsHelp: "last",
    contextUsage: "pin",
    btw: "hidden",
    sessionStatus: "pin",
    projectQueue: "pin",
    projectQueueNewSessionShortcut: "hidden",
    syntheticDone: "off",
    composerRecall: "hidden",
  };
  return {
    defaultPresence,
    version: { capabilities: [] as string[] },
    presence: { ...defaultPresence },
  };
});

vi.mock("../../../components/SessionToolbarPreview", () => ({
  SessionToolbarPreview: () => <div data-testid="toolbar-preview" />,
  ToolbarControlPreview: ({
    activationLabel,
    controlKey,
    onActivate,
  }: {
    activationLabel?: string;
    controlKey: string;
    onActivate?: () => void;
  }) => (
    <button
      type="button"
      data-testid={`toolbar-control-preview-${controlKey}`}
      aria-label={activationLabel}
      onClick={onActivate}
    >
      {controlKey}
    </button>
  ),
}));

vi.mock("../../../hooks/useSessionToolbarPresence", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useSessionToolbarPresence: () => {
      const [, forceRender] = React.useState(0);
      return {
        presence: state.presence,
        setControlPresence: (
          key: keyof typeof state.presence,
          value: string,
        ) => {
          state.presence = { ...state.presence, [key]: value };
          forceRender((count) => count + 1);
        },
        resetPresence: () => {
          state.presence = { ...state.defaultPresence };
          forceRender((count) => count + 1);
        },
      };
    },
  };
});

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { clientDefaults: {} },
    error: null,
    updateSettings: vi.fn(async () => ({ settings: {} })),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: state.version,
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (
        ({
          appearanceToolbarHiddenHeading: "Hidden",
          appearanceToolbarHiddenDescription: "Off controls",
          appearanceToolbarShownHeading: "Shown",
          appearanceToolbarShownDescription: "On controls",
          appearanceToolbarSideLeft: "Left side",
          appearanceToolbarSideRight: "Right side",
          appearanceToolbarSideNoneHidden: "None hidden",
          appearanceToolbarModeTitle: "Mode Selector",
          appearanceToolbarModeDescription: "Show the permission mode selector",
          appearanceToolbarAttachmentsTitle: "Attachments",
          appearanceToolbarAttachmentsDescription: "Attach files",
          appearanceToolbarSlashTitle: "Slash Menu",
          appearanceToolbarSlashDescription: "Show slash commands",
          appearanceToolbarThinkingTitle: "Thinking Toggle",
          appearanceToolbarThinkingDescription: "Show thinking controls",
          appearanceToolbarRenderModeTitle: "Render Mode",
          appearanceToolbarRenderModeDescription: "Show rendered/source toggle",
          appearanceToolbarConversationViewTitle: "Conversation View",
          appearanceToolbarConversationViewDescription:
            "Show condensed conversation",
          appearanceToolbarBrowserDebugTitle: "Remote Browser Debugging",
          appearanceToolbarBrowserDebugDescription:
            "Grant full JavaScript access to this tab",
          appearanceToolbarConversationViewTurnLimitTitle:
            "Conversation View history",
          appearanceToolbarConversationViewTurnLimitDescription:
            "Latest user turns",
          appearanceToolbarConversationViewTurnLimitUnit: "turns",
          appearanceToolbarMicrophoneTitle: "Microphone",
          appearanceToolbarMicrophoneDescription: "Show microphone",
          appearanceToolbarWaveformTitle: "Live Microphone Waveform",
          appearanceToolbarWaveformDescription: "Show waveform",
          appearanceToolbarWaveformButtonOpacityTitle:
            "Button background opacity over waveform",
          appearanceToolbarWaveformButtonOpacityDescription:
            "Keep button foregrounds solid",
          appearanceToolbarWaveformButtonOpacityUnit: "%",
          appearanceToolbarShortcutsTitle: "Shortcuts Help",
          appearanceToolbarShortcutsDescription: "Show shortcuts",
          appearanceToolbarTranscriptSearchTitle: "Transcript Search",
          appearanceToolbarTranscriptSearchDescription: "Show search",
          appearanceToolbarContextTitle: "Context Usage",
          appearanceToolbarContextDescription: "Show context usage",
          appearanceToolbarBtwTitle: "/btw Button",
          appearanceToolbarBtwDescription: "Show /btw",
          appearanceToolbarNudgeTitle: "Heartbeat/Nudge Button",
          appearanceToolbarNudgeDescription: "Show nudge",
          appearanceToolbarSyntheticDoneTitle: "/done Button",
          appearanceToolbarSyntheticDoneDescription: "Mark done locally",
          appearanceToolbarStatusTitle: "Session Status",
          appearanceToolbarStatusDescription: "Show status",
          appearanceToolbarSteerNowTitle: '"Now" steering selector',
          appearanceToolbarSteerNowDescription: "Show now selector",
          appearanceToolbarProjectQueueTitle: "Project Queue",
          appearanceToolbarProjectQueueDescription:
            "Send after all sessions in this project are idle",
          appearanceToolbarProjectQueueNewSessionShortcutTitle:
            "Queue as New Session Shortcut",
          appearanceToolbarProjectQueueNewSessionShortcutDescription:
            "Queue a separate session from an existing composer",
          appearanceToolbarComposerRecallTitle: "Message recall button",
          appearanceToolbarComposerRecallDescription:
            "Open the earlier-message recall list",
          appearanceSessionToolbarDescription: "Toolbar controls",
          appearanceToolbarDefaultActionTitle: "Default action",
          appearanceToolbarDefaultActionDescription: "Choose an action",
          appearanceToolbarDefaultActionSteer: "Steer",
          appearanceToolbarDefaultActionQueue: "Queue",
          appearanceToolbarCollapsedButtonTitle: "Collapsed button",
          appearanceToolbarCollapsedButtonDescription: "Choose a button",
          appearanceToolbarCollapsedButtonPrimary: "Primary",
          appearanceToolbarCollapsedButtonAlternate: "Alternate",
          appearanceToolbarCollapsedButtonMicrophone: "Microphone",
          appearanceToolbarPresenceAria: `${params?.control} visibility`,
          appearanceToolbarPresenceOffCaption: "Disabled",
          appearanceToolbarPresenceHiddenCaption: "Not shown on the toolbar.",
          appearanceToolbarPresenceFirstCaption: "Collapses first",
          appearanceToolbarPresenceMidCaption: "Collapses in the middle",
          appearanceToolbarPresenceLastCaption: "Collapses last",
          appearanceToolbarPresencePinCaption: "Never collapses",
          appearanceToolbarPresenceShownCaption: "Always visible",
          appearanceToolbarActivateControl: `Edit ${params?.control}`,
          appearanceSessionToolbarReset: "Reset",
          appearanceToolbarHide: "Hide",
          appearanceToolbarOff: "Off",
          appearanceToolbarShowAlways: "Show always",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("ToolbarSettings", () => {
  beforeEach(() => {
    state.version = { capabilities: [] };
    state.presence = { ...state.defaultPresence };
    setConversationViewTurnLimit(DEFAULT_CONVERSATION_VIEW_TURN_LIMIT);
    setWaveformButtonBackgroundOpacityPercent(
      DEFAULT_WAVEFORM_BUTTON_BACKGROUND_OPACITY_PERCENT,
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("hides browser debugging unless the server contract is present", () => {
    render(<ToolbarSettings />);

    expect(screen.queryByText("Remote Browser Debugging")).toBe(null);
  });

  it("offers browser debugging hidden with normal toolbar priorities", () => {
    state.version = {
      capabilities: [REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY],
    };

    render(<ToolbarSettings />);

    const row = screen
      .getByText("Remote Browser Debugging")
      .closest("[data-toolbar-control]");
    expect(row).toBeTruthy();
    const slider = within(row as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "Remote Browser Debugging visibility" },
    );
    expect(slider.value).toBe("0");
    expect(slider.getAttribute("max")).toBe("4");

    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.pointerUp(slider);

    expect(state.presence.browserDebug).toBe("mid");
  });

  it("shows the shortcut control hidden when its capability is present", () => {
    state.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
      ],
    };

    render(<ToolbarSettings />);

    const shortcutRow = screen
      .getByText("Queue as New Session Shortcut")
      .closest("[data-toolbar-control]");
    expect(shortcutRow).toBeTruthy();
    expect(
      within(shortcutRow as HTMLElement).getByRole<HTMLInputElement>("slider", {
        name: "Queue as New Session Shortcut visibility",
      }).value,
    ).toBe("0");
  });

  it("ships the message recall button hidden, with only Hide / Show always", () => {
    render(<ToolbarSettings />);

    const row = screen
      .getByText("Message recall button")
      .closest("[data-toolbar-control]");
    expect(row).toBeTruthy();
    const slider = within(row as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "Message recall button visibility" },
    );
    expect(slider.value).toBe("0");
    // Keyboard-row only, so it never enters the toolbar overflow engine.
    expect(slider.getAttribute("max")).toBe("1");
  });

  it("shows synthetic done only with capability and gives it an Off notch", () => {
    state.version = {
      capabilities: [SYNTHETIC_DONE_COMMAND_CAPABILITY],
    };
    render(<ToolbarSettings />);

    const row = screen
      .getByText("/done Button")
      .closest("[data-toolbar-control]");
    expect(row).toBeTruthy();
    const slider = within(row as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "/done Button visibility" },
    );
    expect(slider.value).toBe("0");
    expect(slider.getAttribute("max")).toBe("5");

    fireEvent.change(slider, { target: { value: "1" } });
    fireEvent.pointerUp(slider);
    expect(state.presence.syntheticDone).toBe("hidden");
  });

  it("shows a presence slider for every control row", () => {
    render(<ToolbarSettings />);

    // 17 control-presence sliders plus Conversation View history, waveform
    // button-background opacity, and question reminder duration.
    expect(screen.getAllByRole("slider")).toHaveLength(20);
    expect(
      screen
        .getByRole("slider", { name: "Transcript Search visibility" })
        .getAttribute("max"),
    ).toBe("4");
    // Overflow-supported controls get the full notch scale...
    expect(
      screen
        .getByRole("slider", { name: "Mode Selector visibility" })
        .getAttribute("max"),
    ).toBe("4");
    expect(
      screen
        .getByRole("slider", { name: "Conversation View visibility" })
        .getAttribute("max"),
    ).toBe("4");
    // ...while non-overflow controls only get Hide / Show always.
    expect(
      screen
        .getByRole("slider", { name: "Microphone visibility" })
        .getAttribute("max"),
    ).toBe("1");
  });

  it("finds custom per-button settings in search", () => {
    render(
      <SettingsSearchScopeProvider
        value={{
          query: "attachments",
          matchValues: false,
          rowMatched: false,
          categoryLabel: "Toolbar",
          jumpToItem: vi.fn(),
        }}
      >
        <ToolbarSettings />
      </SettingsSearchScopeProvider>,
    );

    expect(
      screen.getByRole("slider", { name: "Attachments visibility" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("slider", { name: "Mode Selector visibility" }),
    ).toBeNull();
    expect(screen.queryByTestId("session-toolbar-preview")).toBeNull();
  });

  it("configures the browser-local Conversation View history window", () => {
    render(<ToolbarSettings />);

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "Conversation View history",
    });
    expect(slider.value).toBe("100");

    fireEvent.change(slider, { target: { value: "150" } });
    fireEvent.pointerUp(slider);

    expect(slider.value).toBe("150");
  });

  it("configures browser-local button opacity beside the waveform control", () => {
    render(<ToolbarSettings />);

    const waveformRow = screen
      .getByText("Live Microphone Waveform")
      .closest("[data-toolbar-control]");
    expect(waveformRow).toBeTruthy();
    const slider = within(
      waveformRow as HTMLElement,
    ).getByRole<HTMLInputElement>("slider", {
      name: "Button background opacity over waveform",
    });
    expect(slider.value).toBe("70");

    fireEvent.change(slider, { target: { value: "40" } });
    fireEvent.pointerUp(slider);

    expect(slider.value).toBe("40");
  });

  it("keeps hidden overflow controls priority-editable", () => {
    render(<ToolbarSettings />);

    const row = screen
      .getByText("Render Mode")
      .closest("[data-toolbar-control]");
    expect(row).toBeTruthy();
    const slider = within(row as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "Render Mode visibility" },
    );
    expect(slider.getAttribute("max")).toBe("4");
    expect(slider.value).toBe("0");

    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.pointerUp(slider);

    expect(state.presence.renderMode).toBe("last");
  });

  it("focuses the row slider from the specimen affordance", () => {
    render(<ToolbarSettings />);

    fireEvent.click(screen.getByTestId("toolbar-control-preview-modeSelector"));

    expect(document.activeElement).toBe(
      screen.getByRole("slider", { name: "Mode Selector visibility" }),
    );
  });

  it("groups shown controls by toolbar side", () => {
    render(<ToolbarSettings />);

    const shownZone = screen.getByText("Shown").closest("[data-toolbar-zone]");
    expect(shownZone).toBeTruthy();

    const leftGroup = within(shownZone as HTMLElement).getByText(
      "Left side",
    ).parentElement;
    const rightGroup = within(shownZone as HTMLElement).getByText(
      "Right side",
    ).parentElement;
    expect(leftGroup).toBeTruthy();
    expect(rightGroup).toBeTruthy();
    expect(
      within(leftGroup as HTMLElement).getByText("Mode Selector"),
    ).toBeTruthy();
    expect(
      within(leftGroup as HTMLElement).queryByText("Session Status"),
    ).toBeNull();
    expect(
      within(rightGroup as HTMLElement).getByText("Session Status"),
    ).toBeTruthy();
    expect(
      within(rightGroup as HTMLElement).queryByText("Mode Selector"),
    ).toBeNull();
  });

  it("keeps rows in their entry section after visibility changes", () => {
    render(<ToolbarSettings />);

    const shownZone = screen.getByText("Shown").closest("[data-toolbar-zone]");
    const hiddenZone = screen
      .getByText("Hidden")
      .closest("[data-toolbar-zone]");
    expect(shownZone).toBeTruthy();
    expect(hiddenZone).toBeTruthy();

    const modeRow = within(shownZone as HTMLElement)
      .getByText("Mode Selector")
      .closest("[data-toolbar-control]");
    expect(modeRow).toBeTruthy();

    const slider = within(modeRow as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "Mode Selector visibility" },
    );
    fireEvent.change(slider, { target: { value: "0" } });
    fireEvent.pointerUp(slider);

    expect(state.presence.modeSelector).toBe("hidden");
    expect(
      within(shownZone as HTMLElement).getByText("Mode Selector"),
    ).toBeTruthy();
    expect(
      within(hiddenZone as HTMLElement).queryByText("Mode Selector"),
    ).toBeNull();
  });

  it("hiding forgets the tier; sliding back out picks the landed notch", () => {
    render(<ToolbarSettings />);

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "Slash Menu visibility",
    });
    expect(slider.value).toBe("2");

    fireEvent.change(slider, { target: { value: "0" } });
    fireEvent.pointerUp(slider);
    expect(state.presence.slashMenu).toBe("hidden");

    fireEvent.change(slider, { target: { value: "4" } });
    fireEvent.pointerUp(slider);
    expect(state.presence.slashMenu).toBe("pin");
  });
});
