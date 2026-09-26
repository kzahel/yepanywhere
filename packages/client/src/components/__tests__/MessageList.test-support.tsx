import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, type Mock, vi } from "vitest";
import { AgentContentProvider } from "../../contexts/AgentContentContext";
import { RenderModeProvider } from "../../contexts/RenderModeContext";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { StreamingMarkdownProvider } from "../../contexts/StreamingMarkdownContext";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { UI_KEYS } from "../../lib/storageKeys";
import type { Message } from "../../types";
import { MessageList } from "../MessageList";

vi.mock("../../i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../i18n")>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        processingThinkingTranscriptHide:
          "Hide thinking transcript rows (display only; the agent keeps working)",
        processingThinkingTranscriptShowHidden:
          "Show hidden thinking transcript rows",
        processingThinkingTranscriptShowWhenAvailable:
          "Show thinking transcript rows when available",
        sessionQuoteBlock: "Quote this block",
        sessionSteerNow: "Steer now",
        sessionSteerQueuedMessageNow: "Steer queued message now",
        sessionSteerQueuedMessageThrough:
          "Steer this and {count} earlier patient message{suffix} now",
        sessionQueuedCopy: "Copy queued message",
        sessionQueuedYaCommandAfterTurn: "Queued (after current turn)",
        sessionQueuedEdit: "Edit queued message",
        sessionQueuedCancel: "Cancel queued message",
        sessionQueuedInlineEditLabel: "Edit queued message text",
        sessionQueuedInlineSave: "Save edit",
        sessionQueuedInlineCancel: "Cancel edit (Esc)",
        sessionLoading: "Loading session...",
        sessionProgressiveRenderingAriaLabel: "Transcript rendering progress",
        sessionProgressiveRenderingStatus: "Rendering transcript {percent}%",
        sessionFollow: "Follow",
        sessionFollowLatestOutput: "Follow latest session output",
        sessionNewOutputBelow: "New output below",
        sessionNewOutputBelowTitle: "Jump to latest session output",
        sessionConversationLatestTurns: "Latest {count} user turns shown",
        sessionConversationLoadEarlierTurns: "Load {count} earlier user turns",
        sessionRecentTranscriptLoaded: "Recent transcript loaded",
        sessionLoadOlderMessages: "Load older messages",
        sessionLoadingOlderMessages: "Loading...",
        sessionOlderLoadContinuationRequired:
          "Loaded a large history span without reaching an earlier user turn. Load older messages again to continue.",
        sessionSearchHelpNavigate:
          "{shortcutKeys} prev · ↑↓ matches · click jumps",
        sessionSearchHelpClose: "Enter jump+close · Esc cancel · Aa case",
        sessionSearchOlder: "Search older",
        sessionSearchMoreOlder: "More",
        sessionSearchSearchingOlder: "Searching…",
        sessionSearchOlderPages: "{count} older page(s) searched",
        sessionSearchOlderResult: "Older result",
        sessionSearchLoadingResult: "Loading result…",
        sessionSearchOlderError: "Older history unavailable; retry",
        sessionSearchOlderLimit: "Result limit reached; refine the query",
        sessionSearchStartReached: "Start of session reached",
        sessionSearchStartWrap: "Start of session · wrapped",
        sessionSearchEndWrap: "Last match · wrapped",
        sessionSearchCoverage: "Percentage of session messages checked",
        sessionSearchPrevious: "Previous match",
        sessionSearchNext: "Next match",
        sessionSearchGo: "Go",
        sessionSearchGoLabel: "Go to selected match",
        sessionSearchHistoryGap:
          "Unloaded history omitted · recent transcript continues below",
        sessionQuoteSelection: "Quote reply",
        sessionQuoteSelectionShort: "Quote",
        sessionCopySelectionText: "Copy text",
        sessionCopySelectionSource: "Copy source",
        sessionCopySelectionRich: "Copy selection as rich text",
        sessionNewSessionFromSelection: "New session",
        sessionSelectionActionMenu: "Selected text actions",
        sessionDismissSelectionActions: "Dismiss selected text actions",
        viewerSelectAll: "Select all",
        viewerSelectAllTitle: "Select all (Ctrl/Cmd+A)",
        sourceActionMenu: "Source actions",
        sourceDismissActions: "Dismiss source actions",
        projectQueueAttachmentOnly: "Attachment-only message",
        projectQueueInlineStatusQueued: "Project Queue (#{position})",
        projectQueueInlineStatusDispatching:
          "Project Queue sending (#{position})",
        projectQueueInlineStatusFailed: "Project Queue failed (#{position})",
        projectQueueInlineCopy: "Copy Project Queue message",
        projectQueueInlineEdit: "Edit Project Queue item",
        projectQueueInlineSteer: "Steer Project Queue item now",
        projectQueueInlineCancel: "Cancel Project Queue item",
        projectQueueResume: "Resume",
        projectQueueEdit: "Edit",
        projectQueueCancel: "Cancel",
        userPromptCopyAction: "Copy message text",
        userPromptEditAction: "Edit latest message",
        userPromptCancelUnconfirmedAction: "Cancel sent steering message",
        forkTurnMenuLabel: "Fork from this turn",
        forkTurnBefore: "Before this turn",
        forkTurnAfter: "After this turn",
        forkTurnAfterSummary: "After with summary…",
        forkTurnAfterDisabled: "Available after this response completes",
        explorationTitlePending: "Exploring",
        explorationTitleComplete: "Explored",
        explorationItemCountOne: "{count} item",
        explorationItemCountMany: "{count} items",
        explorationCollapse: "Collapse explored tools",
        explorationExpand: "Expand explored tools",
        explorationShowCommandDetails: "Show command details",
        explorationHideCommandDetails: "Hide command details",
        explorationLine: "line {line}",
        explorationLineRange: "lines {start}-{end}",
        conversationActivitySingular: "activity",
        conversationActivityPlural: "activities",
        conversationActivityActive: "Working {duration} · {count} {activity}",
        conversationActivityActiveWithoutTime: "Working · {count} {activity}",
        conversationActivityComplete: "{duration} · {count} {activity} hidden",
        conversationActivityCompleteWithoutTime: "{count} {activity} hidden",
        conversationActivityExpanded: "{duration} · {count} {activity}",
        conversationActivityExpandedWithoutTime: "{count} {activity}",
        conversationActivityExpandTitle:
          "Show hidden activity in its original positions",
        conversationActivityCollapseTitle:
          "Collapse this turn's routine activity",
        conversationThinkingPreviewCurrent: "Current thinking",
        conversationThinkingPreviewLatest: "Latest thinking",
        conversationThinkingPreviewPrevious: "Previous thinking",
        conversationThinkingPreviewCollapse: "Collapse thinking preview",
        conversationThinkingPreviewExpand: "Expand thinking preview",
        conversationThinkingPreviewDismiss: "Dismiss {label}",
        conversationRecentActivities: "Most recent activities",
        turnImageGalleryCount: "{current} of {count}",
        turnImageGalleryCollapse: "Collapse gallery",
        turnImageGalleryExpand: "Expand gallery",
        turnImageGalleryExpandAt: "Expand gallery at {label}",
        turnImageGalleryLabel: "Turn image gallery",
        turnImageGalleryOpen: "Open {label}",
        turnImageGalleryShow: "Gallery",
        inlineImageLoading: "Loading image…",
        inlineImageUnavailable: "Image unavailable",
        imageViewerGalleryNavigation: "Gallery image navigation",
        imageViewerGalleryPosition: "{current} of {count}",
        imageViewerPrevious: "Previous image",
        imageViewerNext: "Next image",
      };
      const value = translations[key] ?? key;
      return value.replace(/\{(\w+)\}/g, (_, param: string) =>
        String(params?.[param] ?? `{${param}}`),
      );
    },
  }),
}));

const originalClipboard = navigator.clipboard;
const originalClipboardItem = globalThis.ClipboardItem;
const originalMatchMedia = window.matchMedia;

export function userMessage(
  uuid: string,
  content: string,
  timestamp?: string,
): Message {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content },
  };
}

export function assistantMessage(
  uuid: string,
  content: string,
  timestamp?: string,
): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", content },
  };
}

export function assistantToolUseMessage(
  uuid: string,
  content: NonNullable<Message["message"]>["content"],
  timestamp?: string,
): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", content },
  };
}

export function codexThinkingMessage(
  uuid: string,
  thinking: string,
  timestamp?: string,
  isStreaming = false,
): Message {
  return {
    type: "assistant",
    uuid,
    timestamp,
    _isStreaming: isStreaming,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  };
}

export function systemMessage(
  uuid: string,
  content: string,
  details?: Array<NonNullable<Message["content"]>>,
): Message {
  return {
    type: "system",
    uuid,
    subtype: "compact_boundary",
    content,
    ...(details ? { details } : {}),
  };
}

export function recapMessage(uuid: string, content: string): Message {
  return {
    type: "system",
    uuid,
    subtype: "away_summary",
    content,
  };
}

export function dispatchCopyEvent(): {
  event: ClipboardEvent;
  setData: Mock<DataTransfer["setData"]>;
} {
  const setData = vi.fn<DataTransfer["setData"]>();
  const event = new Event("copy", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: { setData },
  });

  document.dispatchEvent(event);
  return { event, setData };
}

export function stubClipboardWriteText() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

export function mockPointerCoarse(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => {
      const mediaQueryList = {
        matches: query === "(pointer: coarse)" ? matches : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      } as MediaQueryList;
      return mediaQueryList;
    }),
  });
}

export function SessionTranscriptHarness({
  messages,
}: {
  messages: Message[];
}) {
  return (
    <StreamingMarkdownProvider>
      <RenderModeProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/repo"
          sessionId="session-1"
        >
          <AgentContentProvider
            agentContent={{}}
            mergeLoadedAgentContent={() => {}}
            toolUseToAgent={new Map()}
            projectId="project-1"
            sessionId="session-1"
          >
            <MessageList
              messages={messages}
              provider="codex"
              markdownAugments={{
                "assistant-1": {
                  html: '<ol><li>First item</li><li>Second item</li></ol><pre class="code-block"><code>const superLongIdentifierName = "value";</code></pre>',
                },
              }}
            />
          </AgentContentProvider>
        </SessionMetadataProvider>
      </RenderModeProvider>
    </StreamingMarkdownProvider>
  );
}

export function installMessageListTestEnvironment() {
  beforeEach(() => {
    vi.useRealTimers();

    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
    window.localStorage.clear();
    // Most MessageList suites exercise the full transcript. Product-default
    // Conversation View behavior has dedicated rendering tests.
    window.localStorage.setItem(UI_KEYS.conversationView, "false");
    invalidateLocalStorageValues();
  });

  afterEach(() => {
    document.querySelectorAll(".session-input-inner").forEach((node) => {
      node.remove();
    });
    document
      .querySelectorAll("[data-selection-actions-mobile-slot]")
      .forEach((node) => {
        node.remove();
      });
    document.querySelectorAll("textarea").forEach((node) => {
      node.remove();
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    if (originalClipboardItem === undefined) {
      Reflect.deleteProperty(globalThis, "ClipboardItem");
    } else {
      Object.defineProperty(globalThis, "ClipboardItem", {
        configurable: true,
        value: originalClipboardItem,
      });
    }
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}
