// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useQuoteableTextSource } from "../../hooks/useQuoteableTextSource";
import { UI_KEYS } from "../../lib/storageKeys";
import { extractMarkdownSnippetsFromSelection } from "../../lib/markdownSelectionCopy";
import { SESSION_FILE_COMMENT_MODE_ATTR } from "../../lib/sessionFileComments";
import {
  installMessageListTestEnvironment,
  SessionTranscriptHarness,
  assistantMessage,
  dispatchCopyEvent,
  mockPointerCoarse,
  recapMessage,
  userMessage,
} from "./MessageList.test-support";
import { ActivityDetailModal } from "../ActivityDetailModal";
import { MarkdownPreview } from "../MarkdownPreview";
import { MessageList } from "../MessageList";
import { Modal } from "../ui/Modal";

installMessageListTestEnvironment();

function QuoteableModal() {
  const textRef = useQuoteableTextSource<HTMLParagraphElement>(
    "Modal selected text",
  );
  return (
    <Modal title="Expanded edit" onClose={() => {}}>
      <p ref={textRef}>Modal selected text</p>
    </Modal>
  );
}

function QuoteableMarkdownModal() {
  const previewRef = useQuoteableTextSource<HTMLDivElement>("# Modal heading");
  return (
    <Modal title="Rendered document" onClose={() => {}}>
      <div ref={previewRef}>
        <MarkdownPreview html="<h1>Modal heading</h1>" />
      </div>
    </Modal>
  );
}

function SessionFileCommentModal() {
  const textRef = useQuoteableTextSource<HTMLParagraphElement>(
    "Comment-selected text",
  );
  return (
    <Modal title="Commenting document" onClose={() => {}}>
      <div {...{ [SESSION_FILE_COMMENT_MODE_ATTR]: "true" }}>
        <p ref={textRef}>Comment-selected text</p>
      </div>
    </Modal>
  );
}

function SelectableActivityModal() {
  const textRef = useQuoteableTextSource<HTMLParagraphElement>(
    "Selectable run output",
  );
  return (
    <ActivityDetailModal
      title="Run output"
      label="Run output"
      onClose={() => {}}
    >
      <p ref={textRef}>Selectable run output</p>
    </ActivityDetailModal>
  );
}

describe("MessageList selection and copy", () => {
  it("hides Markdown copy for a partial user selection containing literal syntax", async () => {
    mockPointerCoarse(true);
    const onQuoteSelection = vi.fn(() => "> command\n");
    render(
      <MessageList
        messages={[
          userMessage("user-1", "Use `long_command` and **literal** text."),
        ]}
        onQuoteSelection={onQuoteSelection}
      />,
    );
    const element = screen.getByText(
      "Use `long_command` and **literal** text.",
    );
    const node = element.firstChild as Text;
    const start = node.data.indexOf("command");
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + "command".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.pointerDown(element, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(element, { clientX: 180, clientY: 120 });
    const quote = await screen.findByRole("button", { name: "Quote reply" });
    expect(screen.queryByRole("button", { name: "Copy Markdown" })).toBeNull();
    expect(
      extractMarkdownSnippetsFromSelection(
        document.querySelector("[data-message-list]")!,
      )[0],
    ).toMatchObject({
      markdown: "command",
      selectedText: "command",
      isLiteral: true,
    });
    fireEvent.contextMenu(element, {
      clientX: 0,
      clientY: 0,
      pointerType: "mouse",
    });
    expect(
      screen.queryByRole("menuitem", { name: "Copy Markdown" }),
    ).toBeNull();
    fireEvent.click(quote);
    expect(onQuoteSelection).toHaveBeenCalledWith("> command\n");
  });

  it("offers Markdown copy only when the selected part has formatting", async () => {
    mockPointerCoarse(false);
    render(
      <MessageList
        messages={[
          assistantMessage("assistant-1", "Plain text and **formatted text**."),
        ]}
        markdownAugments={{
          "assistant-1": {
            html: "<p>Plain text and <strong>formatted text</strong>.</p>",
          },
        }}
        onQuoteSelection={() => ""}
      />,
    );
    const strong = screen.getByText("formatted text");
    const paragraph = strong.parentElement!;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, "Plain text".length);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.pointerDown(paragraph, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(paragraph, { clientX: 180, clientY: 120 });
    await screen.findByRole("button", { name: "Quote reply" });
    expect(screen.queryByRole("button", { name: "Copy Markdown" })).toBeNull();
    range.selectNodeContents(strong);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.pointerDown(strong, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(strong, { clientX: 180, clientY: 120 });
    expect(
      await screen.findByRole("button", { name: "Copy Markdown" }),
    ).toBeTruthy();
    fireEvent.contextMenu(strong, { clientX: 0, clientY: 0 });
    expect(
      screen.getByRole("menuitem", { name: "Copy Markdown" }),
    ).toBeTruthy();
  });

  it("copies rendered assistant selections as visible text", () => {
    render(
      <MessageList
        messages={[
          assistantMessage("assistant-1", "1. First item\n1. Second item"),
        ]}
        markdownAugments={{
          "assistant-1": {
            html: "<ol><li>First item</li><li>Second item</li></ol>",
          },
        }}
      />,
    );

    const secondItem = screen.getByText("Second item");
    const textNode = secondItem.firstChild;
    expect(textNode).toBeTruthy();
    const range = document.createRange();
    range.setStart(textNode as Node, 0);
    range.setEnd(textNode as Node, secondItem.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const { event, setData } = dispatchCopyEvent();

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "Second item");
  });

  it("offers text, source, quote, and new-session actions for a selection", () => {
    const onStartNewSessionFromSelection = vi.fn();
    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Selected text")]}
        onQuoteSelection={() => "> Selected text\n"}
        onStartNewSessionFromSelection={onStartNewSessionFromSelection}
      />,
    );

    const selectedElement = screen.getByText("Selected text");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(selectedElement, { clientX: 0, clientY: 0 });

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Copy text", "Quote reply", "New session"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "New session" }));
    expect(onStartNewSessionFromSelection).toHaveBeenCalledWith(
      "> Selected text",
    );
  });

  it("leaves touch selection context menus browser-owned", () => {
    mockPointerCoarse(false);
    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Touch selected text")]}
        onQuoteSelection={() => "> Touch selected text\n"}
      />,
    );

    const selectedElement = screen.getByText("Touch selected text");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    Object.defineProperty(contextMenuEvent, "pointerType", {
      value: "touch",
    });

    expect(fireEvent(selectedElement, contextMenuEvent)).toBe(true);
    expect(
      screen.queryByRole("menu", { name: "Selected text actions" }),
    ).toBeNull();
  });

  it("keeps legacy coarse-pointer selection menus browser-owned", () => {
    mockPointerCoarse(true);
    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Mobile selected text")]}
        onQuoteSelection={() => "> Mobile selected text\n"}
      />,
    );

    const selectedElement = screen.getByText("Mobile selected text");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(
      fireEvent.contextMenu(selectedElement, { clientX: 10, clientY: 10 }),
    ).toBe(true);
    const mouseCompatibleEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    Object.defineProperty(mouseCompatibleEvent, "pointerType", {
      value: "mouse",
    });
    expect(fireEvent(selectedElement, mouseCompatibleEvent)).toBe(true);
    expect(
      screen.queryByRole("menu", { name: "Selected text actions" }),
    ).toBeNull();
  });

  it("distinguishes visible text from the registered source in the menu", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "1. Selected source")]}
        markdownAugments={{
          "assistant-1": {
            html: "<ol><li>Selected source</li></ol>",
          },
        }}
      />,
    );

    const selectedElement = screen.getByText("Selected source");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    const selection = window.getSelection();
    const selectAgain = () => {
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    selectAgain();
    fireEvent.contextMenu(selectedElement, { clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy text" }));
    expect(writeText).toHaveBeenLastCalledWith("Selected source");

    selectAgain();
    fireEvent.contextMenu(selectedElement, { clientX: 0, clientY: 0 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    expect(writeText).toHaveBeenLastCalledWith("1. Selected source");
  });

  it("offers the configurable new-session bubble action", async () => {
    window.localStorage.setItem(
      UI_KEYS.selectionNewSessionActionEnabled,
      "true",
    );
    const onStartNewSessionFromSelection = vi.fn();
    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Selected handoff")]}
        onStartNewSessionFromSelection={onStartNewSessionFromSelection}
      />,
    );

    const selectedElement = screen.getByText("Selected handoff");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.pointerDown(selectedElement, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const newSessionButton = await screen.findByRole("button", {
      name: "New session",
    });
    fireEvent.click(newSessionButton);

    expect(onStartNewSessionFromSelection).toHaveBeenCalledWith(
      "> Selected handoff",
    );
  });

  it("preserves old rendered assistant DOM when later messages append", () => {
    const first = assistantMessage(
      "assistant-1",
      "1. First item\n1. Second item",
      "2026-04-25T00:00:00.000Z",
    );
    const { rerender } = render(
      <SessionTranscriptHarness messages={[first]} />,
    );

    const selectedElement = screen.getByText("Second item");
    const selectedTextNode = selectedElement.firstChild;
    expect(selectedTextNode).toBeTruthy();
    const codeBlock = document.querySelector(
      "[data-code-block]",
    ) as HTMLElement | null;
    expect(codeBlock).toBeTruthy();
    if (codeBlock) {
      codeBlock.scrollLeft = 73;
    }

    const range = document.createRange();
    range.setStart(selectedTextNode as Node, 0);
    range.setEnd(selectedTextNode as Node, "Second item".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    rerender(
      <SessionTranscriptHarness
        messages={[
          first,
          assistantMessage(
            "assistant-2",
            "new complete response",
            "2026-04-25T00:01:00.000Z",
          ),
        ]}
      />,
    );

    const nextSelectedElement = screen.getByText("Second item");
    const nextCodeBlock = document.querySelector(
      "[data-code-block]",
    ) as HTMLElement | null;

    expect(nextSelectedElement).toBe(selectedElement);
    expect(selectedTextNode?.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe("Second item");
    expect(nextCodeBlock).toBe(codeBlock);
    expect(codeBlock?.isConnected).toBe(true);
    expect(nextCodeBlock?.scrollLeft).toBe(73);
  });

  it("copies mixed turn selections as separate source snippets", () => {
    render(
      <MessageList
        messages={[
          userMessage("user-1", "user selected text"),
          assistantMessage("assistant-1", "assistant selected text"),
        ]}
      />,
    );

    const userText = screen.getByText("user selected text").firstChild;
    const assistantText = screen.getByText(
      "assistant selected text",
    ).firstChild;
    expect(userText).toBeTruthy();
    expect(assistantText).toBeTruthy();

    const range = document.createRange();
    range.setStart(userText as Node, 0);
    range.setEnd(assistantText as Node, "assistant selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const { event, setData } = dispatchCopyEvent();

    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "user selected text\n\nassistant selected text",
    );
  });

  it("shields session chrome while transcript text is selected", () => {
    mockPointerCoarse(true);

    const activeAttribute = "data-session-transcript-selection-active";
    const { container, unmount } = render(
      <div data-session-page>
        <MessageList
          messages={[
            assistantMessage("assistant-1", "selected assistant text"),
          ]}
        />
      </div>,
    );
    const shell = container.querySelector("[data-session-page]");
    const selectedText = screen.getByText("selected assistant text").firstChild;
    expect(shell).toBeInstanceOf(HTMLElement);
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "selected assistant text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect((shell as HTMLElement).hasAttribute(activeAttribute)).toBe(true);
    expect(document.body.hasAttribute(activeAttribute)).toBe(true);

    selection?.removeAllRanges();
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect((shell as HTMLElement).hasAttribute(activeAttribute)).toBe(false);
    expect(document.body.hasAttribute(activeAttribute)).toBe(false);

    selection?.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect((shell as HTMLElement).hasAttribute(activeAttribute)).toBe(true);

    unmount();

    expect((shell as HTMLElement).hasAttribute(activeAttribute)).toBe(false);
    expect(document.body.hasAttribute(activeAttribute)).toBe(false);
  });

  it("does not shield session chrome for desktop pointer selection", () => {
    mockPointerCoarse(false);

    const activeAttribute = "data-session-transcript-selection-active";
    const { container } = render(
      <div data-session-page>
        <MessageList
          messages={[assistantMessage("assistant-1", "desktop selected text")]}
        />
      </div>,
    );
    const shell = container.querySelector("[data-session-page]");
    const selectedText = screen.getByText("desktop selected text").firstChild;
    expect(shell).toBeInstanceOf(HTMLElement);
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "desktop selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect((shell as HTMLElement).hasAttribute(activeAttribute)).toBe(false);
    expect(document.body.hasAttribute(activeAttribute)).toBe(false);
  });

  it("quotes recap selections through the reply pipeline", () => {
    const onQuoteSelection = vi.fn(() => "> Recap selected text\nx");

    render(
      <MessageList
        messages={[recapMessage("recap-1", "Recap selected text")]}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const recapText = screen.getByText("Recap selected text").firstChild;
    expect(recapText).toBeTruthy();
    const range = document.createRange();
    range.setStart(recapText as Node, 0);
    range.setEnd(recapText as Node, "Recap selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyDown(window, { key: "x" });

    expect(onQuoteSelection).toHaveBeenCalledWith("> Recap selected text\nx");
  });

  it("hides and disables selection quoting independently", async () => {
    window.localStorage.setItem(UI_KEYS.selectionQuoteActionEnabled, "false");
    window.localStorage.setItem(
      UI_KEYS.selectionSourceCopyActionEnabled,
      "true",
    );
    const onQuoteSelection = vi.fn(() => "> Selected text\nx");

    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "**Selected text**")]}
        markdownAugments={{
          "assistant-1": { html: "<p><strong>Selected text</strong></p>" },
        }}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const selectedElement = screen.getByText("Selected text");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.pointerDown(selectedElement, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    expect(
      await screen.findByRole("button", {
        name: "Copy Markdown",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Quote reply" })).toBeNull();

    fireEvent.keyDown(window, { key: "x" });
    expect(onQuoteSelection).not.toHaveBeenCalled();
  });

  it("keeps the selected-text quote button inside the transcript on desktop", async () => {
    mockPointerCoarse(false);
    const onQuoteSelection = vi.fn(() => "> Desktop selected text\n");

    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Desktop selected text")]}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const selectedElement = screen.getByText("Desktop selected text");
    const selectedText = selectedElement.firstChild;
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "Desktop selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.pointerDown(selectedElement, { clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const quoteButton = await screen.findByRole("button", {
      name: "Quote reply",
    });
    expect(quoteButton.closest("[data-message-list]")).toBeTruthy();
    expect(
      quoteButton.closest('[data-selection-action-cluster="true"]'),
    ).toBeTruthy();

    fireEvent.click(quoteButton);

    expect(onQuoteSelection).toHaveBeenCalledWith("> Desktop selected text\n");
  });

  it("moves a three-action cluster before a selection near the right edge", async () => {
    mockPointerCoarse(false);
    window.localStorage.setItem(
      UI_KEYS.selectionSourceCopyActionEnabled,
      "true",
    );
    window.localStorage.setItem(UI_KEYS.selectionRichCopyActionEnabled, "true");

    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "**Right edge selection**")]}
        markdownAugments={{
          "assistant-1": {
            html: "<p><strong>Right edge selection</strong></p>",
          },
        }}
        onQuoteSelection={() => "> Right edge selection\n"}
      />,
    );

    const messageList = document.querySelector<HTMLElement>(
      "[data-message-list]",
    );
    expect(messageList).toBeTruthy();
    if (!messageList) throw new Error("Message list is missing");
    Object.defineProperties(messageList, {
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 400 },
    });
    messageList.getBoundingClientRect = () =>
      ({
        top: 0,
        right: 600,
        bottom: 400,
        left: 0,
        width: 600,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const selectedElement = screen.getByText("Right edge selection");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 100,
          right: 590,
          bottom: 120,
          left: 500,
          width: 90,
          height: 20,
          x: 500,
          y: 100,
          toJSON: () => ({}),
        }) as DOMRect,
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    const sourceButton = await screen.findByRole("button", {
      name: "Copy Markdown",
    });
    const cluster = sourceButton.closest(
      '[data-selection-action-cluster="true"]',
    );
    expect(cluster).toBeTruthy();
    if (!cluster) throw new Error("Selection action cluster is missing");
    expect(cluster.getAttribute("data-selection-action-placement")).toBe(
      "before",
    );
    expect(cluster.querySelectorAll("button")).toHaveLength(3);
  });

  it("quotes registered text from a portaled modal into the active session", async () => {
    mockPointerCoarse(false);
    const onQuoteSelection = vi.fn(() => "> Modal selected text\n");
    const onStartNewSessionFromSelection = vi.fn();

    render(
      <>
        <MessageList
          messages={[assistantMessage("assistant-1", "Transcript text")]}
          onQuoteSelection={onQuoteSelection}
          onStartNewSessionFromSelection={onStartNewSessionFromSelection}
        />
        <QuoteableModal />
      </>,
    );

    const selectedElement = screen.getByText("Modal selected text");
    const selectedText = selectedElement.firstChild;
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "Modal selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(selectedElement, { clientX: 0, clientY: 0 });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Copy text", "Quote reply", "New session"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.pointerDown(selectedElement, { clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const quoteButton = await screen.findByRole("button", {
      name: "Quote reply",
    });
    expect(quoteButton.closest("[data-modal-frame]")).toBeTruthy();
    expect(quoteButton.closest("[data-message-list]")).toBeNull();

    fireEvent.click(quoteButton);

    expect(onQuoteSelection).toHaveBeenCalledWith("> Modal selected text\n");
  });

  it("keeps enabled selection tools but suppresses quote actions in file comment mode", async () => {
    mockPointerCoarse(false);
    window.localStorage.setItem(UI_KEYS.selectionTextCopyActionEnabled, "true");
    render(
      <>
        <MessageList
          messages={[assistantMessage("assistant-1", "Transcript text")]}
          onQuoteSelection={() => "> Comment-selected text\n"}
          onStartNewSessionFromSelection={vi.fn()}
        />
        <SessionFileCommentModal />
      </>,
    );

    const selectedElement = screen.getByText("Comment-selected text");
    const range = document.createRange();
    range.selectNodeContents(selectedElement);
    const selection = window.getSelection();
    const selectAgain = () => {
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    selectAgain();
    fireEvent.contextMenu(selectedElement, { clientX: 0, clientY: 0 });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Copy text", "New session"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    selectAgain();
    fireEvent.pointerDown(selectedElement, { clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });
    expect(
      await screen.findByRole("button", { name: "Copy text" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Quote reply" })).toBeNull();
  });

  it("opens the selection action circle after viewer select-all", async () => {
    mockPointerCoarse(false);
    const originalRangeRect = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect",
    );
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 100,
        right: 300,
        bottom: 120,
        left: 100,
        width: 200,
        height: 20,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }),
    });

    try {
      render(
        <>
          <MessageList
            messages={[assistantMessage("assistant-1", "Transcript text")]}
            onQuoteSelection={() => "> Selectable run output\n"}
          />
          <SelectableActivityModal />
        </>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Select all" }));

      const modal = document.querySelector<HTMLElement>("[data-modal-frame]");
      expect(document.getSelection()?.toString()).toBe("Selectable run output");
      expect(modal).toBeTruthy();
      expect(extractMarkdownSnippetsFromSelection(modal!)).toMatchObject([
        { markdown: "Selectable run output" },
      ]);

      const quoteButton = await screen.findByRole("button", {
        name: "Quote reply",
      });
      expect(
        quoteButton.closest('[data-selection-action-cluster="true"]'),
      ).toBeTruthy();
      expect(quoteButton.closest("[data-modal-frame]")).toBeTruthy();
    } finally {
      if (originalRangeRect) {
        Object.defineProperty(
          Range.prototype,
          "getBoundingClientRect",
          originalRangeRect,
        );
      } else {
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    }
  });

  it("keeps a modal selection fallback beside the range, not the tall source", async () => {
    mockPointerCoarse(false);
    const originalGetClientRects = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getClientRects",
    );
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [
        {
          top: 100,
          right: 760,
          bottom: 120,
          left: 20,
          width: 740,
          height: 20,
        },
      ],
    });

    try {
      render(
        <>
          <MessageList
            messages={[assistantMessage("assistant-1", "Transcript text")]}
            onQuoteSelection={() => "> Modal selected text\n"}
          />
          <QuoteableModal />
        </>,
      );

      const modal = document.querySelector<HTMLElement>("[data-modal-frame]");
      const selectedElement = screen.getByText("Modal selected text");
      const selectedText = selectedElement.firstChild;
      expect(modal).toBeTruthy();
      expect(selectedText).toBeTruthy();
      if (!modal || !selectedText)
        throw new Error("Modal selection is missing");
      Object.defineProperties(modal, {
        clientWidth: { configurable: true, value: 800 },
        clientHeight: { configurable: true, value: 800 },
      });
      modal.getBoundingClientRect = () =>
        ({
          top: 0,
          right: 800,
          bottom: 800,
          left: 0,
          width: 800,
          height: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      selectedElement.getBoundingClientRect = () =>
        ({
          top: 20,
          right: 780,
          bottom: 700,
          left: 20,
          width: 760,
          height: 680,
          x: 20,
          y: 20,
          toJSON: () => ({}),
        }) as DOMRect;

      const range = document.createRange();
      range.setStart(selectedText, "Modal ".length);
      range.setEnd(selectedText, "Modal selected".length);
      Object.defineProperties(range, {
        getBoundingClientRect: {
          configurable: true,
          value: () => ({
            top: 100,
            right: 760,
            bottom: 120,
            left: 20,
            width: 740,
            height: 20,
          }),
        },
        getClientRects: {
          configurable: true,
          value: () => [
            {
              top: 100,
              right: 760,
              bottom: 120,
              left: 20,
              width: 740,
              height: 20,
            },
          ],
        },
      });
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      act(() => document.dispatchEvent(new Event("selectionchange")));

      const quoteButton = await screen.findByRole("button", {
        name: "Quote reply",
      });
      const cluster = quoteButton.closest<HTMLElement>(
        '[data-selection-action-cluster="true"]',
      );
      expect(cluster?.dataset.selectionActionPlacement).toBe("below");
      expect(cluster?.style.top).toBe("126px");
    } finally {
      if (originalGetClientRects) {
        Object.defineProperty(
          Range.prototype,
          "getClientRects",
          originalGetClientRects,
        );
      } else {
        Reflect.deleteProperty(Range.prototype, "getClientRects");
      }
    }
  });

  it("copies rendered document selections as source markdown", () => {
    render(
      <>
        <MessageList
          messages={[assistantMessage("assistant-1", "Transcript text")]}
        />
        <QuoteableMarkdownModal />
      </>,
    );

    const heading = screen.getByRole("heading", { name: "Modal heading" });
    const headingText = heading.firstChild;
    expect(headingText).toBeTruthy();

    const range = document.createRange();
    range.selectNodeContents(headingText as Node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const setData = vi.fn();
    fireEvent.copy(heading, {
      clipboardData: { setData },
    });

    expect(setData).toHaveBeenCalledWith("text/plain", "Modal heading");
  });

  it("docks the tappable quote action above the mobile composer", async () => {
    mockPointerCoarse(true);
    const onQuoteSelection = vi.fn(() => "> Mobile selected text\n");
    const actionSlot = document.createElement("div");
    actionSlot.setAttribute("data-selection-actions-mobile-slot", "");
    document.body.appendChild(actionSlot);

    render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Mobile selected text")]}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const selectedElement = screen.getByText("Mobile selected text");
    const selectedText = selectedElement.firstChild;
    expect(selectedText).toBeTruthy();

    const range = document.createRange();
    range.setStart(selectedText as Node, 0);
    range.setEnd(selectedText as Node, "Mobile selected text".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.pointerDown(selectedElement, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const quoteButton = await screen.findByRole("button", {
      name: "Quote reply",
    });
    expect(actionSlot.contains(quoteButton)).toBe(true);
    expect(screen.queryByRole("button", { name: "Copy Markdown" })).toBeNull();
    expect(
      quoteButton.closest('[data-selection-action-cluster="true"]'),
    ).toBeTruthy();

    selection?.removeAllRanges();
    fireEvent.click(quoteButton);

    expect(onQuoteSelection).toHaveBeenCalledWith("> Mobile selected text\n");
  });

  it("copies stored source from the mobile selection action", async () => {
    mockPointerCoarse(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const actionSlot = document.createElement("div");
    actionSlot.setAttribute("data-selection-actions-mobile-slot", "");
    document.body.appendChild(actionSlot);
    render(
      <MessageList
        messages={[
          assistantMessage("assistant-1", "1. Mobile selected source"),
        ]}
        markdownAugments={{
          "assistant-1": {
            html: "<ol><li>Mobile selected source</li></ol>",
          },
        }}
      />,
    );

    const selectedElement = screen.getByText("Mobile selected source");
    const selectedText = selectedElement.firstChild;
    expect(selectedText).toBeTruthy();
    const range = document.createRange();
    range.selectNodeContents(selectedText as Node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.pointerDown(selectedElement, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const sourceButton = await screen.findByRole("button", {
      name: "Copy Markdown",
    });
    expect(actionSlot.contains(sourceButton)).toBe(true);

    selection?.removeAllRanges();
    fireEvent.click(sourceButton);

    expect(writeText).toHaveBeenCalledWith("1. Mobile selected source");
  });

  it("copies stored semantic HTML after the selection collapses", async () => {
    mockPointerCoarse(false);
    window.localStorage.setItem(UI_KEYS.selectionRichCopyActionEnabled, "true");
    const clipboardItems: Array<Record<string, Blob>> = [];
    class FakeClipboardItem {
      constructor(data: Record<string, Blob>) {
        clipboardItems.push(data);
      }
    }
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: FakeClipboardItem,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    });

    render(
      <MessageList
        messages={[
          assistantMessage("assistant-1", "The **rich selection** stays bold."),
        ]}
        markdownAugments={{
          "assistant-1": {
            html: "<p>The <strong>rich selection</strong> stays bold.</p>",
          },
        }}
      />,
    );

    const selectedElement = screen.getByText("rich selection");
    const range = document.createRange();
    range.selectNode(selectedElement);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.pointerDown(selectedElement, { clientX: 100, clientY: 120 });
    fireEvent.pointerUp(selectedElement, { clientX: 180, clientY: 120 });

    const richButton = await screen.findByRole("button", {
      name: "Copy selection as rich text",
    });
    selection?.removeAllRanges();
    fireEvent.click(richButton);

    expect(write).toHaveBeenCalledTimes(1);
    expect(clipboardItems[0]?.["text/html"]?.type).toBe("text/html");
    expect(clipboardItems[0]?.["text/plain"]?.type).toBe("text/plain");
  });
});
