// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { setConversationViewPreference } from "../../hooks/useConversationView";
import { createTranscriptPositionStore } from "../../lib/transcriptPositionStore";
import {
  installMessageListTestEnvironment,
  assistantMessage,
  codexThinkingMessage,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

describe("MessageList scroll and follow", () => {
  it("follows viewport shrink only while the reader is following", () => {
    const observers: {
      callback: ResizeObserverCallback;
      targets: Element[];
    }[] = [];
    class CapturingResizeObserver {
      targets: Element[] = [];
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });
    const { container } = render(<MessageList messages={[]} />);
    let viewportHeight = 500;
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, get: () => viewportHeight },
      scrollTop: { configurable: true, value: 500, writable: true },
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;
    const viewportObservers = observers.filter((observer) =>
      observer.targets.includes(container),
    );
    expect(viewportObservers.length).toBeGreaterThan(0);
    const resize = () =>
      act(() => {
        for (const observer of viewportObservers) {
          observer.callback([], {} as ResizeObserver);
        }
      });
    resize();
    viewportHeight = 300;
    resize();
    expect(container.scrollTop).toBe(700);

    fireEvent.wheel(container, { deltaY: -120 });
    container.scrollTop = 100;
    fireEvent.scroll(container);
    viewportHeight = 200;
    resize();
    expect(container.scrollTop).toBe(100);
  });

  it("lets slow upward scrolling inside the bottom slack escape follow", () => {
    const observers: ResizeObserverCallback[] = [];
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });
    const { container } = render(
      <MessageList messages={[assistantMessage("assistant-1", "streaming")]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 500, writable: true },
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 500);
    const lastLine = container.querySelector("[data-message-list]")
      ?.lastElementChild as HTMLElement | null;
    expect(lastLine).toBeTruthy();
    // The last line ends 16px above the viewport bottom (container padding)
    // when pinned, so the first few px of an upward scroll keep it visible.
    (lastLine as HTMLElement).getBoundingClientRect = () =>
      rectFor(400 + scrollHeight - 500 - container.scrollTop, 84);
    const grow = (px: number) =>
      act(() => {
        scrollHeight += px;
        for (const callback of observers) {
          callback([], {} as ResizeObserver);
        }
      });
    grow(100);
    expect(container.scrollTop).toBe(600);

    // Each slow wheel step moves a few px before streaming growth arrives.
    for (const step of [1, 2, 3]) {
      fireEvent.wheel(container, { deltaY: -100 });
      container.scrollTop -= 5;
      fireEvent.scroll(container);
      grow(50);
      expect(container.scrollTop).toBe(600 - 5 * step);
    }

    // Returning to the live edge by scrolling down resumes following.
    container.scrollTop = scrollHeight - 500;
    fireEvent.scroll(container);
    grow(50);
    expect(container.scrollTop).toBe(scrollHeight - 500);
  });

  it("focuses the transcript after a native scrollbar gesture", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect this"),
          assistantMessage("assistant-1", "Visible answer"),
        ]}
      />,
    );
    container.tabIndex = -1;
    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      value: 380,
    });
    Object.defineProperty(container, "offsetWidth", {
      configurable: true,
      value: 400,
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();

    fireEvent(
      container,
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 395,
      }),
    );

    expect(document.activeElement).toBe(container);
  });

  it("keeps a clicked activity summary fixed while scrolled up", async () => {
    const observers: {
      callback: ResizeObserverCallback;
      targets: Element[];
    }[] = [];
    class CapturingResizeObserver {
      targets: Element[] = [];
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });
    let lateGrowth = 0;
    setConversationViewPreference(true);
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect this"),
          codexThinkingMessage("thinking-1", "private planning"),
          assistantMessage("assistant-1", "Visible answer"),
          userMessage("user-2", "next question"),
          assistantMessage("assistant-2", "Later answer"),
        ]}
      />,
    );
    const resize = () =>
      act(() => {
        for (const observer of observers.filter(({ targets }) =>
          targets.includes(container),
        )) {
          observer.callback([], {} as ResizeObserver);
        }
      });
    const summary = screen.getByRole("button", {
      name: /activity hidden/,
    });
    const summaryRow = summary.closest<HTMLElement>("[data-render-id]");
    expect(summaryRow?.dataset.renderId).toBeTruthy();
    const summaryId = summaryRow?.dataset.renderId;

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () =>
        container
          .querySelector("[data-conversation-activity-summary]")
          ?.getAttribute("aria-expanded") === "true"
          ? 1500 + lateGrowth
          : 1200,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 400,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === container) {
          return rectFor(0, 400);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(220 - container.scrollTop, 40);
        }
        if (this.dataset.renderId === summaryId) {
          const expanded =
            this.querySelector(
              "[data-conversation-activity-summary]",
            )?.getAttribute("aria-expanded") === "true";
          return rectFor(
            (expanded ? 750 + lateGrowth : 450) - container.scrollTop,
            40,
          );
        }
        return rectFor(900 - container.scrollTop, 40);
      });

    try {
      const topBefore = summaryRow?.getBoundingClientRect().top;
      expect(summary.getAttribute("aria-expanded")).toBe("false");
      expect(topBefore).toBe(250);
      fireEvent.click(summary);

      await waitFor(() => {
        // Expanded, the summary drops "hidden" and counts the activity only.
        const expandedSummary = screen.getByRole("button", {
          name: /1 activity$/,
        });
        expect(expandedSummary.getAttribute("aria-expanded")).toBe("true");
        expect(
          expandedSummary
            .closest<HTMLElement>("[data-render-id]")
            ?.getBoundingClientRect().top,
        ).toBe(topBefore);
      });

      // Renderer hydration can grow earlier rows after the disclosure commit.
      lateGrowth = 28;
      resize();
      const expandedRow = screen
        .getByRole("button", { name: /1 activity$/ })
        .closest<HTMLElement>("[data-render-id]");
      expect(expandedRow?.getBoundingClientRect().top).toBe(topBefore);
      // A reader gesture releases that anchor before later renderer growth.
      fireEvent.wheel(container, { deltaY: -100 });
      container.scrollTop -= 40;
      fireEvent.scroll(container);
      const readerScrollTop = container.scrollTop;
      lateGrowth += 20;
      resize();
      expect(container.scrollTop).toBe(readerScrollTop);
      const beforeCollapse = expandedRow?.getBoundingClientRect().top;
      fireEvent.click(
        screen.getByRole("button", {
          name: /1 activity$/,
        }),
      );
      await waitFor(() => {
        const collapsedSummary = screen.getByRole("button", {
          name: /activity hidden/,
        });
        expect(collapsedSummary.getAttribute("aria-expanded")).toBe("false");
        expect(
          collapsedSummary
            .closest<HTMLElement>("[data-render-id]")
            ?.getBoundingClientRect().top,
        ).toBe(beforeCollapse);
      });
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("preserves live-tail follow across an active-window prefix trim", () => {
    const onFollowingBottomChange = vi.fn();
    const onScrollSnapshotChange = vi.fn();
    const initialMessages = [
      userMessage("user-1", "old request"),
      assistantMessage("assistant-1", "old response"),
      userMessage("user-2", "retained request"),
      assistantMessage("assistant-2", "retained response"),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={initialMessages}
        activeWindowTrimRevision={0}
        onFollowingBottomChange={onFollowingBottomChange}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });

    fireEvent.scroll(container);
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(true);

    scrollHeight = 600;
    rerender(
      <MessageList
        messages={initialMessages.slice(2)}
        activeWindowTrimRevision={1}
        onFollowingBottomChange={onFollowingBottomChange}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );

    expect(container.scrollTop).toBe(100);
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(true);
    expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ atBottom: true, scrollTop: 100 }),
    );
  });

  it("does not force a trim revision back to bottom after reader intent changes", () => {
    const onFollowingBottomChange = vi.fn();
    const initialMessages = [
      userMessage("user-1", "old request"),
      assistantMessage("assistant-1", "old response"),
      userMessage("user-2", "retained request"),
    ];
    const { container, rerender } = render(
      <MessageList
        messages={initialMessages}
        activeWindowTrimRevision={0}
        onFollowingBottomChange={onFollowingBottomChange}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });

    fireEvent.wheel(container, { deltaY: -120 });
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(false);

    scrollHeight = 600;
    rerender(
      <MessageList
        messages={initialMessages.slice(2)}
        activeWindowTrimRevision={1}
        onFollowingBottomChange={onFollowingBottomChange}
      />,
    );

    expect(container.scrollTop).toBe(100);
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(false);
  });

  it("scrolls to current from a focused composer with Ctrl+End", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    const scrollTo = vi.fn();

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();
    fireEvent.keyDown(editableTarget, {
      key: "End",
      code: "End",
      ctrlKey: true,
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(900);
    editableTarget.remove();
  });

  it("navigates to hidden user turns and skips prompts already fully visible", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first"),
          assistantMessage("assistant-1", "answer one"),
          userMessage("user-2", "second"),
          assistantMessage("assistant-2", "answer two"),
          userMessage("user-3", "third"),
          assistantMessage("assistant-3", "answer three"),
          userMessage("user-4", "fourth"),
          userMessage("user-5", "fifth"),
        ]}
      />,
    );
    const absoluteTops: Record<string, number> = {
      "user-1": 0,
      "user-2": 220,
      "user-3": 400,
      "user-4": 720,
      "user-5": 800,
    };
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 650,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1100,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === container) return rectFor(0, 300);
        const absoluteTop = this.dataset.renderId
          ? absoluteTops[this.dataset.renderId]
          : undefined;
        return rectFor(
          absoluteTop === undefined ? 1000 : absoluteTop - container.scrollTop,
          40,
        );
      });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      if (typeof options.top === "number") container.scrollTop = options.top;
    }) as typeof container.scrollTo;

    try {
      fireEvent.keyDown(window, { key: "Home", code: "Home" });
      expect(container.scrollTop).toBe(388);
      fireEvent.keyDown(window, {
        key: "Home",
        code: "Home",
        repeat: true,
      });
      expect(container.scrollTop).toBe(208);

      container.scrollTop = 100;
      fireEvent.keyDown(window, { key: "End", code: "End" });
      expect(container.scrollTop).toBe(388);
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("preserves editor Home/End and offers Alt+Arrow turn accelerators", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first"),
          assistantMessage("assistant-1", "answer one"),
          userMessage("user-2", "second"),
        ]}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number): DOMRect =>
      ({
        top,
        bottom: top + 40,
        height: 40,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === container) return rectFor(0);
        if (this.dataset.renderId === "user-1") {
          return rectFor(100 - container.scrollTop);
        }
        if (this.dataset.renderId === "user-2") {
          return rectFor(700 - container.scrollTop);
        }
        return rectFor(1000 - container.scrollTop);
      });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      if (typeof options.top === "number") container.scrollTop = options.top;
    }) as typeof container.scrollTo;
    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();

    try {
      fireEvent.keyDown(editableTarget, { key: "Home", code: "Home" });
      expect(container.scrollTop).toBe(500);
      fireEvent.keyDown(editableTarget, {
        key: "ArrowUp",
        code: "ArrowUp",
        altKey: true,
      });
      expect(container.scrollTop).toBe(88);

      container.scrollTop = 300;
      fireEvent.keyDown(editableTarget, { key: "End", code: "End" });
      expect(container.scrollTop).toBe(300);
      fireEvent.keyDown(editableTarget, {
        key: "ArrowDown",
        code: "ArrowDown",
        altKey: true,
      });
      expect(container.scrollTop).toBe(688);
    } finally {
      editableTarget.remove();
      rectSpy.mockRestore();
    }
  });

  it("shows a composer follow control when scrolled away from latest", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);
    const onFollowCurrent = vi.fn();

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        onFollowCurrent={onFollowCurrent}
      />,
    );
    const scrollTo = vi.fn();

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Follow latest session output",
      }),
    );

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(500);
    expect(onFollowCurrent).toHaveBeenCalledTimes(1);
    composerTarget.remove();
  });

  it("publishes live-tail return state when Follow is activated", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);
    const onScrollSnapshotChange = vi.fn();
    const promptTimestamp = "2026-08-26T12:00:00.000Z";

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request", promptTimestamp),
          assistantMessage(
            "assistant-1",
            "current response",
            "2026-08-26T12:01:00.000Z",
          ),
        ]}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 500);
    const user = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const lastLine = container.querySelector<HTMLElement>("[data-message-list]")
      ?.lastElementChild as HTMLElement | null;
    expect(user).toBeTruthy();
    expect(assistant).toBeTruthy();
    expect(lastLine).toBeTruthy();
    (user as HTMLElement).getBoundingClientRect = () => rectFor(-80, 40);
    (assistant as HTMLElement).getBoundingClientRect = () => rectFor(120, 280);
    (lastLine as HTMLElement).getBoundingClientRect = () => rectFor(120, 380);

    fireEvent.wheel(container, { deltaY: -120 });
    onScrollSnapshotChange.mockClear();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Follow latest session output",
      }),
    );

    expect(container.scrollTop).toBe(500);
    expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        atBottom: true,
        following: true,
        seenTurn: {
          id: "user-1",
          timestampMs: new Date(promptTimestamp).getTime(),
          activityIndex: 1,
        },
      }),
    );
  });

  it("retargets the position timestamp to a hovered row's start time", async () => {
    const onTranscriptPositionTimestampChange = vi.fn();
    const assistantStart = "2026-04-26T12:04:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "earlier response", assistantStart),
        ]}
        onTranscriptPositionTimestampChange={
          onTranscriptPositionTimestampChange
        }
      />,
    );

    const row = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    expect(row).toBeTruthy();
    fireEvent.pointerOver(row as HTMLElement);

    // Hover overrides even in follow mode, where scroll position reports null.
    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        new Date(assistantStart).getTime(),
      );
    });

    // Leaving the transcript (composer / dead area) restores the status quo.
    const messageList = container.querySelector<HTMLElement>(
      "[data-message-list]",
    );
    fireEvent.pointerLeave(messageList as HTMLElement);
    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        null,
      );
    });
  });

  it("reports the most recent visible turn end while scrolled back", async () => {
    const onTranscriptPositionTimestampChange = vi.fn();
    const assistantEnd = "2026-04-26T12:04:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "earlier response", assistantEnd),
          userMessage("user-2", "current request", "2026-04-26T12:05:00.000Z"),
          assistantMessage(
            "assistant-2",
            "current response",
            "2026-04-26T12:06:00.000Z",
          ),
        ]}
        onTranscriptPositionTimestampChange={
          onTranscriptPositionTimestampChange
        }
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    container.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    const user1 = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant1 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const user2 = container.querySelector<HTMLElement>(
      '[data-render-id="user-2"]',
    );
    const assistant2 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-2"]',
    );
    const assistantTurns = container.querySelectorAll<HTMLElement>(
      "[data-assistant-turn]",
    );
    const firstAssistantTurn = assistantTurns.item(0);
    const lastAssistantTurn = assistantTurns.item(1);
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    expect(user2).toBeTruthy();
    expect(assistant2).toBeTruthy();
    expect(assistantTurns).toHaveLength(2);
    expect(firstAssistantTurn).toBeTruthy();
    expect(lastAssistantTurn).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(-220, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(80, 70);
    (user2 as HTMLElement).getBoundingClientRect = () => rectFor(220, 40);
    (assistant2 as HTMLElement).getBoundingClientRect = () => rectFor(380, 80);
    (firstAssistantTurn as HTMLElement).getBoundingClientRect = () =>
      rectFor(80, 70);
    (lastAssistantTurn as HTMLElement).getBoundingClientRect = () =>
      rectFor(380, 80);

    fireEvent.wheel(container, { deltaY: -120 });
    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        new Date(assistantEnd).getTime(),
      );
    });
  });

  it("indexes transcript rows once after scrolling settles", () => {
    const onTranscriptPositionTimestampChange = vi.fn();
    let pendingPositionFrame: FrameRequestCallback | null = null;
    const transcriptPositionStore = createTranscriptPositionStore({
      request: (callback) => {
        pendingPositionFrame = callback;
        return 1;
      },
      cancel: () => {
        pendingPositionFrame = null;
      },
    });
    const assistantEnd = "2026-04-26T12:04:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "earlier response", assistantEnd),
          userMessage("user-2", "current request", "2026-04-26T12:05:00.000Z"),
          assistantMessage(
            "assistant-2",
            "current response",
            "2026-04-26T12:06:00.000Z",
          ),
        ]}
        onTranscriptPositionTimestampChange={
          onTranscriptPositionTimestampChange
        }
        transcriptPositionStore={transcriptPositionStore}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 300);
    const userRow = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistantRow = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const currentUserRow = container.querySelector<HTMLElement>(
      '[data-render-id="user-2"]',
    );
    const currentAssistantRow = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-2"]',
    );
    const assistantTurns = container.querySelectorAll<HTMLElement>(
      "[data-assistant-turn]",
    );
    const messageList = container.querySelector<HTMLDivElement>(
      "[data-message-list]",
    );
    expect(userRow).toBeTruthy();
    expect(assistantRow).toBeTruthy();
    expect(currentUserRow).toBeTruthy();
    expect(currentAssistantRow).toBeTruthy();
    expect(assistantTurns).toHaveLength(2);
    expect(messageList).toBeTruthy();
    (userRow as HTMLElement).getBoundingClientRect = () => rectFor(-220, 40);
    (assistantRow as HTMLElement).getBoundingClientRect = () => rectFor(80, 70);
    (currentUserRow as HTMLElement).getBoundingClientRect = () =>
      rectFor(220, 40);
    (currentAssistantRow as HTMLElement).getBoundingClientRect = () =>
      rectFor(380, 80);
    assistantTurns.item(0).getBoundingClientRect = () => rectFor(80, 70);
    assistantTurns.item(1).getBoundingClientRect = () => rectFor(380, 80);
    const rowQuerySpy = vi.spyOn(
      messageList as HTMLDivElement,
      "querySelectorAll",
    );
    fireEvent.wheel(container, { deltaY: -120 });

    vi.useFakeTimers();
    try {
      fireEvent.scroll(container);
      fireEvent.scroll(container);
      fireEvent.scroll(container);
      expect(
        rowQuerySpy.mock.calls.filter(
          ([selector]) => selector === "[data-render-id]",
        ),
      ).toHaveLength(0);

      act(() => vi.advanceTimersByTime(199));
      expect(
        rowQuerySpy.mock.calls.filter(
          ([selector]) => selector === "[data-render-id]",
        ),
      ).toHaveLength(0);

      act(() => vi.advanceTimersByTime(1));
      expect(
        rowQuerySpy.mock.calls.filter(
          ([selector]) => selector === "[data-render-id]",
        ),
      ).toHaveLength(1);
      act(() => {
        const frame = pendingPositionFrame;
        pendingPositionFrame = null;
        frame?.(0);
      });
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        new Date(assistantEnd).getTime(),
      );
    } finally {
      vi.useRealTimers();
      rowQuerySpy.mockRestore();
    }
  });

  it("uses the middle visible row when no turn end is visible", async () => {
    const onTranscriptPositionTimestampChange = vi.fn();
    const assistantMiddle = "2026-04-26T12:05:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "long request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "long response", assistantMiddle),
        ]}
        onTranscriptPositionTimestampChange={
          onTranscriptPositionTimestampChange
        }
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    container.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    const user1 = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant1 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const assistantTurn = container.querySelector<HTMLElement>(
      "[data-assistant-turn]",
    );
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    expect(assistantTurn).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(-120, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(-80, 520);
    (assistantTurn as HTMLElement).getBoundingClientRect = () =>
      rectFor(-80, 520);

    fireEvent.wheel(container, { deltaY: -120 });
    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onTranscriptPositionTimestampChange).toHaveBeenLastCalledWith(
        new Date(assistantMiddle).getTime(),
      );
    });
  });

  it("captures neighbor and timestamp context with scroll anchors", async () => {
    const onScrollSnapshotChange = vi.fn();
    const assistantTimestamp = "2026-04-26T12:01:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "previous request", "2026-04-26T12:00:00.000Z"),
          assistantMessage(
            "assistant-1",
            "visible response",
            assistantTimestamp,
          ),
          userMessage("user-2", "next request", "2026-04-26T12:02:00.000Z"),
        ]}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 120,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 300);

    const user1 = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant1 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    const user2 = container.querySelector<HTMLElement>(
      '[data-render-id="user-2"]',
    );
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    expect(user2).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(-120, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(40, 80);
    (user2 as HTMLElement).getBoundingClientRect = () => rectFor(360, 40);

    fireEvent.wheel(container, { deltaY: -120 });
    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          atBottom: false,
          scrollTop: 120,
          anchor: {
            id: "assistant-1",
            topOffset: 40,
            previousId: "user-1",
            nextId: "user-2",
            timestampMs: new Date(assistantTimestamp).getTime(),
          },
        }),
      );
    });
  });

  it("keeps catching up after Follow while output grows", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const messageList = container.querySelector<HTMLElement>(
      "[data-message-list]",
    );
    const lastLine = messageList?.lastElementChild as HTMLElement | null;
    expect(lastLine).toBeTruthy();
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
    } as DOMRect);
    vi.spyOn(
      lastLine as HTMLElement,
      "getBoundingClientRect",
    ).mockImplementation(
      () =>
        ({
          bottom: scrollHeight - container.scrollTop,
        }) as DOMRect,
    );
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    });
    container.scrollTo = scrollTo as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.useFakeTimers();
    fireEvent.click(followButton);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(500);

    act(() => {
      for (const callback of animationFrames.splice(0)) {
        callback(0);
      }
    });
    scrollHeight = 1400;
    fireEvent.scroll(container);
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(900);
    expect(
      screen.queryByRole("button", {
        name: "Follow latest session output",
      }),
    ).toBeNull();
    composerTarget.remove();
  });

  it("keeps following visible thinking after a user send", () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: CapturingResizeObserver,
    });

    const firstThought = codexThinkingMessage(
      "thinking-1",
      "Initial visible thought",
      "2026-08-10T03:04:40.000Z",
      true,
    );
    const confirmedSteer = userMessage("steer-1", "Clarify the diff scope");
    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[firstThought]}
      />,
    );
    fireEvent.wheel(container, { deltaY: -120 });
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[firstThought, confirmedSteer]}
        scrollTrigger={1}
      />,
    );
    expect(container.scrollTop).toBe(500);

    scrollHeight = 1400;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought\nReasoning after the accepted steer",
            "2026-08-10T03:04:40.000Z",
            true,
          ),
          confirmedSteer,
        ]}
        scrollTrigger={1}
      />,
    );
    act(() => {
      for (const callback of resizeCallbacks) {
        callback([], {} as ResizeObserver);
      }
    });

    expect(container.scrollTop).toBe(900);
  });

  it("pins a steering send before the next paint while following", () => {
    const firstThought = codexThinkingMessage(
      "thinking-1",
      "Initial visible thought",
      "2026-08-26T18:00:00.000Z",
      true,
    );
    const pendingSteer = {
      tempId: "steer-1",
      content: "Clarify the diff scope",
      timestamp: "2026-08-26T18:00:01.000Z",
      status: "Sending...",
    };
    const layoutScrollTops: number[] = [];
    let scrollHeight = 1000;
    let sendSteer: (() => void) | null = null;

    function SteeringHarness() {
      const [sent, setSent] = useState(false);
      const viewportRef = useRef<HTMLDivElement>(null);
      sendSteer = () => {
        scrollHeight = 1400;
        setSent(true);
      };
      useLayoutEffect(() => {
        if (sent && viewportRef.current) {
          layoutScrollTops.push(viewportRef.current.scrollTop);
        }
      }, [sent]);

      return (
        <div ref={viewportRef}>
          <MessageList
            provider="codex"
            isProcessing
            conversationViewEnabledOverride
            messages={[firstThought]}
            pendingMessages={sent ? [pendingSteer] : []}
            scrollTrigger={sent ? 1 : 0}
          />
        </div>
      );
    }

    const { container } = render(<SteeringHarness />);
    const viewport = container.firstElementChild as HTMLDivElement;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 500,
    });

    act(() => sendSteer?.());

    expect(layoutScrollTops).toEqual([900]);
    expect(viewport.scrollTop).toBe(900);
  });

  it("does not follow visible thinking deltas until Follow is clicked", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

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

    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );

    scrollHeight = 1400;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought\nA longer visible thinking delta",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(500);
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });

    fireEvent.click(followButton);
    expect(container.scrollTop).toBe(900);

    scrollHeight = 1600;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            [
              "Initial visible thought",
              "A longer visible thinking delta",
              "Another visible thinking delta after Follow",
            ].join("\n"),
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(1100);
    composerTarget.remove();
  });

  it("re-pins an active follower to the new bottom when content shrinks", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

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

    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );

    // Grow while not following, which surfaces the Follow control.
    scrollHeight = 1400;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Initial visible thought\nA longer visible thinking delta",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(container.scrollTop).toBe(500);

    // Opt into follow, setting shouldAutoScroll.
    const followButton = await screen.findByRole("button", {
      name: "Follow latest session output",
    });
    fireEvent.click(followButton);
    expect(container.scrollTop).toBe(900); // 1400 - 500

    // Turn completes: the bounded thinking preview and recent-activity rows
    // collapse out of the flow, so total content height shrinks. An active
    // follower must ride down to the new bottom, not be stranded above it.
    scrollHeight = 1100;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(600); // 1100 - 500
    composerTarget.remove();
  });

  it("re-pins to the new bottom on turn completion while following", () => {
    const { container, rerender } = render(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          userMessage("user-1", "go"),
          assistantMessage("assistant-1", "working"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });

    // Establish an active follow at the bottom.
    fireEvent.scroll(container);

    // Turn completes: the thinking preview and activity rows collapse out of
    // the flow, shrinking total height. The completion-boundary layout effect
    // must re-pin an active follower to the new bottom before a clamp-fired
    // scroll event can read the shrink as a scroll-away.
    scrollHeight = 700;
    rerender(
      <MessageList
        provider="codex"
        isProcessing={false}
        messages={[
          userMessage("user-1", "go"),
          assistantMessage("assistant-1", "done"),
        ]}
      />,
    );

    expect(container.scrollTop).toBe(200); // 700 - 500
  });

  it("publishes a newly completed turn while visibly following", async () => {
    const onScrollSnapshotChange = vi.fn();
    const messages = [
      userMessage("user-1", "go", "2026-08-25T12:00:00.000Z"),
      assistantMessage("assistant-1", "done", "2026-08-25T12:01:00.000Z"),
    ];
    const { container, rerender } = render(
      <MessageList
        isProcessing={true}
        messages={messages}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 500);
    const user = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    expect(user).toBeTruthy();
    expect(assistant).toBeTruthy();
    (user as HTMLElement).getBoundingClientRect = () => rectFor(40, 40);
    (assistant as HTMLElement).getBoundingClientRect = () => rectFor(120, 280);
    onScrollSnapshotChange.mockClear();

    rerender(
      <MessageList
        isProcessing={false}
        messages={messages}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );

    await waitFor(() => {
      expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          completedTurn: {
            id: "user-1",
            timestampMs: new Date("2026-08-25T12:01:00.000Z").getTime(),
          },
          following: true,
        }),
      );
    });
  });

  it("publishes an active turn as seen in Conversation View", async () => {
    const onScrollSnapshotChange = vi.fn();
    const promptTimestamp = "2026-08-25T12:00:00.000Z";
    const { container } = render(
      <MessageList
        conversationViewEnabledOverride
        isProcessing={true}
        messages={[
          userMessage("user-1", "go", promptTimestamp),
          assistantMessage(
            "assistant-1",
            "still working",
            "2026-08-25T12:01:00.000Z",
          ),
        ]}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 400,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 400);
    const user = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    expect(user).toBeTruthy();
    expect(assistant).toBeTruthy();
    (user as HTMLElement).getBoundingClientRect = () => rectFor(-80, 40);
    (assistant as HTMLElement).getBoundingClientRect = () => rectFor(120, 240);
    onScrollSnapshotChange.mockClear();

    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: expect.objectContaining({
            id: "assistant-1",
            topOffset: 120,
          }),
          seenTurn: {
            id: "user-1",
            timestampMs: new Date(promptTimestamp).getTime(),
            activityIndex: 1,
          },
        }),
      );
      expect(
        onScrollSnapshotChange.mock.lastCall?.[0].completedTurn,
      ).toBeUndefined();
    });
  });

  it("captures the furthest visible activity in expanded view", async () => {
    const onScrollSnapshotChange = vi.fn();
    const promptTimestamp = "2026-08-25T12:00:00.000Z";
    const { container } = render(
      <MessageList
        conversationViewEnabledOverride={false}
        isProcessing={true}
        messages={[
          userMessage("user-1", "go", promptTimestamp),
          assistantMessage(
            "assistant-mid",
            "first activity",
            "2026-08-25T12:00:30.000Z",
          ),
          assistantMessage(
            "assistant-1",
            "still working",
            "2026-08-25T12:01:00.000Z",
          ),
        ]}
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 400,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 400);
    const user = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const middleActivity = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-mid"]',
    );
    const assistant = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    expect(user).toBeTruthy();
    expect(middleActivity).toBeTruthy();
    expect(assistant).toBeTruthy();
    (user as HTMLElement).getBoundingClientRect = () => rectFor(-180, 40);
    (middleActivity as HTMLElement).getBoundingClientRect = () =>
      rectFor(-60, 180);
    (assistant as HTMLElement).getBoundingClientRect = () => rectFor(220, 140);
    onScrollSnapshotChange.mockClear();

    fireEvent.scroll(container);

    await waitFor(() => {
      expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          anchor: expect.objectContaining({
            id: "assistant-1",
            topOffset: 220,
          }),
          seenTurn: {
            id: "user-1",
            timestampMs: new Date(promptTimestamp).getTime(),
            activityIndex: 2,
          },
        }),
      );
    });
  });

  for (const intent of ["held press", "wheel"] as const) {
    it(`does not let a pending follow frame override a ${intent}`, () => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frames.set(++nextFrame, callback);
          return nextFrame;
        },
      );
      vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
        frames.delete(id);
      });
      const callbacks: ResizeObserverCallback[] = [];
      class Observer {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      }
      Object.defineProperty(window, "ResizeObserver", {
        configurable: true,
        value: Observer,
      });
      const { container } = render(
        <MessageList
          messages={[
            userMessage("u", "Request"),
            assistantMessage("a", "Current response"),
          ]}
        />,
      );
      let height = 1000;
      Object.defineProperties(container, {
        scrollHeight: { configurable: true, get: () => height },
        clientHeight: { configurable: true, value: 500 },
        scrollTop: { configurable: true, writable: true, value: 500 },
      });
      const resize = () =>
        act(() => {
          for (const callback of callbacks) callback([], {} as ResizeObserver);
        });
      resize();
      expect(frames.size).toBeGreaterThan(0);
      if (intent === "held press") {
        const down = new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 40,
          clientY: 40,
        });
        Object.defineProperty(down, "pointerType", { value: "mouse" });
        fireEvent(screen.getByText("Current response"), down);
        // A scroll event already queued by the previous bottom write is not
        // new reader intent to resume following under a held button.
        fireEvent.scroll(container);
      } else {
        fireEvent.wheel(container, { deltaY: -120 });
      }
      act(() => {
        const pending = Array.from(frames.values());
        frames.clear();
        for (const callback of pending) callback(0);
      });
      height = 1400;
      resize();
      expect(container.scrollTop).toBe(500);
      if (intent === "held press") {
        fireEvent(
          document,
          new MouseEvent("pointerup", {
            bubbles: true,
            button: 0,
            clientX: 40,
            clientY: 40,
          }),
        );
        expect(container.scrollTop).toBe(900);
      }
    });
  }

  it("lets a user wheel away cancel live follow before resize catch-up", () => {
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

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 200,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn() as typeof container.scrollTo;

    fireEvent.wheel(container, { deltaY: -120 });
    container.scrollTop = 320;
    scrollHeight = 1400;
    expect(resizeCallback).not.toBeNull();
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(320);
  });

  it("lets a transcript selection cancel live follow before resize catch-up", () => {
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

    const onFollowingBottomChange = vi.fn();
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        onFollowingBottomChange={onFollowingBottomChange}
      />,
    );
    let scrollHeight = 1000;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    container.scrollTo = vi.fn((options: ScrollToOptions) => {
      container.scrollTop = Number(options.top ?? 0);
    }) as typeof container.scrollTo;
    fireEvent.scroll(container);

    const output = screen.getByText("current response");
    const range = document.createRange();
    range.selectNodeContents(output);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    scrollHeight = 1400;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(container.scrollTop).toBe(500);
    expect(onFollowingBottomChange).toHaveBeenLastCalledWith(false);
  });

  it("cancels live follow only once during a transcript selection drag", () => {
    const onFollowingBottomChange = vi.fn();
    render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        onFollowingBottomChange={onFollowingBottomChange}
      />,
    );

    const output = screen.getByText("current response");
    fireEvent.pointerDown(output, { button: 0 });
    const range = document.createRange();
    range.selectNodeContents(output);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    onFollowingBottomChange.mockClear();

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
      document.dispatchEvent(new Event("selectionchange"));
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(onFollowingBottomChange).toHaveBeenCalledTimes(1);
    expect(onFollowingBottomChange).toHaveBeenCalledWith(false);
  });

  it("lets an upward scroll movement cancel live follow", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 500,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 500,
    });
    const messageList = container.querySelector<HTMLElement>(
      "[data-message-list]",
    );
    const lastLine = messageList?.lastElementChild as HTMLElement | null;
    expect(lastLine).toBeTruthy();
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
    } as DOMRect);
    vi.spyOn(
      lastLine as HTMLElement,
      "getBoundingClientRect",
    ).mockImplementation(
      () =>
        ({
          bottom: 1000 - container.scrollTop,
        }) as DOMRect,
    );

    act(() => {
      for (const callback of animationFrames.splice(0)) {
        callback(0);
      }
    });
    fireEvent.scroll(container);
    container.scrollTop = 300;
    fireEvent.scroll(container);

    expect(container.scrollTop).toBe(300);
    expect(
      await screen.findByRole("button", {
        name: "Follow latest session output",
      }),
    ).toBeDefined();
  });

  it("ignores unanchored top snapshots on initial restore", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        initialScrollSnapshot={{
          atBottom: false,
          scrollTop: 0,
          scrollHeight: 48,
          clientHeight: 500,
          updatedAtMs: Date.now(),
        }}
      />,
      { container: scrollContainer },
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("ignores anchored top snapshots on initial restore", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        initialScrollSnapshot={{
          atBottom: false,
          scrollTop: 0,
          scrollHeight: 1000,
          clientHeight: 500,
          anchor: { id: "user-1", topOffset: 0 },
          updatedAtMs: Date.now(),
        }}
      />,
      { container: scrollContainer },
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("keeps live-tail bottom restore even when the snapshot has an anchor", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        initialScrollSnapshot={{
          atBottom: true,
          scrollTop: 100,
          scrollHeight: 1000,
          clientHeight: 500,
          anchor: { id: "user-1", topOffset: 20 },
          updatedAtMs: Date.now(),
        }}
      />,
      { container: scrollContainer },
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("restores an at-bottom anchor in remember-place mode", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(120, 40);
        }
        return rectFor(0, 40);
      });

    try {
      render(
        <MessageList
          messages={[
            userMessage("user-1", "earlier request"),
            assistantMessage("assistant-1", "current response"),
          ]}
          initialScrollSnapshot={{
            atBottom: true,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: { id: "user-1", topOffset: 20 },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );
    } finally {
      rectSpy.mockRestore();
    }

    expect(scrollContainer.scrollTop).toBe(200);
  });

  it("retries a remembered anchor through growth until the user scrolls", () => {
    const animationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 0;
      });
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

    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    let scrollTop = 0;
    let scrollHeight = 500;
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(value, scrollHeight - 500);
      },
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "assistant-1") {
          return rectFor(-scrollTop, scrollHeight);
        }
        return rectFor(0, 40);
      });

    try {
      render(
        <MessageList
          messages={[
            userMessage("user-1", "earlier request"),
            assistantMessage("assistant-1", "current response"),
          ]}
          initialScrollSnapshot={{
            atBottom: false,
            scrollTop: 4800,
            scrollHeight: 5500,
            clientHeight: 500,
            anchor: { id: "assistant-1", topOffset: -4800 },
            following: false,
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );

      expect(scrollContainer.scrollTop).toBe(0);
      scrollHeight = 5500;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });
      expect(scrollContainer.scrollTop).toBe(4800);

      fireEvent.wheel(scrollContainer, { deltaY: -120 });
      scrollContainer.scrollTop = 4400;
      scrollHeight = 6000;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });
      expect(scrollContainer.scrollTop).toBe(4400);
    } finally {
      animationFrameSpy.mockRestore();
      rectSpy.mockRestore();
    }
  });

  it("falls back to a neighboring row when a remembered anchor is gone", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(160, 40);
        }
        return rectFor(0, 40);
      });

    try {
      render(
        <MessageList
          messages={[
            userMessage("user-1", "surviving request"),
            assistantMessage("assistant-1", "surviving response"),
          ]}
          initialScrollSnapshot={{
            atBottom: false,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: {
              id: "deleted-row",
              topOffset: 20,
              previousId: "user-1",
            },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );
    } finally {
      rectSpy.mockRestore();
    }

    expect(scrollContainer.scrollTop).toBe(240);
  });

  it("falls back to the nearest timestamped row when an anchor is gone", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    const assistantTimestamp = "2026-04-26T12:01:00.000Z";
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 100,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "assistant-1") {
          return rectFor(260, 80);
        }
        return rectFor(0, 40);
      });

    try {
      render(
        <MessageList
          messages={[
            userMessage(
              "user-1",
              "surviving request",
              "2026-04-26T12:00:00.000Z",
            ),
            assistantMessage(
              "assistant-1",
              "surviving response",
              assistantTimestamp,
            ),
          ]}
          initialScrollSnapshot={{
            atBottom: false,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: {
              id: "deleted-row",
              topOffset: 30,
              timestampMs: new Date(assistantTimestamp).getTime(),
            },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );
    } finally {
      rectSpy.mockRestore();
    }

    expect(scrollContainer.scrollTop).toBe(330);
  });

  it("waits for a remember-place anchor to mount during progressive restore", () => {
    vi.useFakeTimers();
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    const messages = Array.from({ length: 150 }, (_, index) => {
      const turn = index + 1;
      return [
        userMessage(`user-${turn}`, `request ${turn}`),
        assistantMessage(`assistant-${turn}`, `response ${turn}`),
      ];
    }).flat();
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1600,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function getRect(this: HTMLElement) {
        if (this === scrollContainer) {
          return rectFor(0, 500);
        }
        if (this.dataset.renderId === "user-1") {
          return rectFor(240, 40);
        }
        return rectFor(900, 80);
      });

    try {
      render(
        <MessageList
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="remember-place-progressive"
          initialScrollSnapshot={{
            atBottom: true,
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            anchor: { id: "user-1", topOffset: 20 },
            updatedAtMs: Date.now(),
          }}
          scrollBehaviorMode="remember-place"
        />,
        { container: scrollContainer },
      );

      expect(
        scrollContainer.querySelector('[data-render-id="user-1"]'),
      ).toBeNull();
      expect(scrollContainer.scrollTop).toBe(0);

      for (let index = 0; index < 6; index += 1) {
        act(() => {
          vi.advanceTimersByTime(40);
        });
      }
      act(() => {
        vi.advanceTimersByTime(220);
      });

      expect(
        scrollContainer.querySelector('[data-render-id="user-1"]'),
      ).toBeTruthy();
      expect(scrollContainer.scrollTop).toBe(220);
      expect(screen.getByText("New output below")).toBeTruthy();

      fireEvent.click(
        screen.getByRole("button", {
          name: "Jump to latest session output",
        }),
      );

      expect(scrollContainer.scrollTop).toBe(1100);
      expect(screen.queryByText("New output below")).toBeNull();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("keeps following the tail when progressive restore reveals rows", () => {
    vi.useFakeTimers();
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    let scrollHeight = 500;
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <MessageList
        messages={[
          userMessage("user-1", "cached request"),
          assistantMessage("assistant-1", "cached response"),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="cached-session"
      />,
      { container: scrollContainer },
    );

    expect(
      scrollContainer.querySelector(
        "[data-message-list-progressive-hydrating]",
      ),
    ).toBeTruthy();

    scrollHeight = 1400;
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(scrollContainer.scrollTop).toBe(900);
  });

  it("catches up a parked transcript on reveal while following latest", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { rerender } = render(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
        inert
      />,
      { container: scrollContainer },
    );
    scrollContainer.scrollTop = 0;

    rerender(
      <MessageList
        messages={[
          userMessage("user-1", "earlier request"),
          assistantMessage("assistant-1", "current response"),
        ]}
      />,
    );

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("ignores parked scroll events before tail-follow reveal", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const messages = [
      userMessage("user-1", "earlier request"),
      assistantMessage("assistant-1", "current response"),
    ];
    const { rerender } = render(<MessageList messages={messages} />, {
      container: scrollContainer,
    });
    expect(scrollContainer.scrollTop).toBe(500);

    rerender(<MessageList messages={messages} inert />);
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        left: 0,
        right: 360,
        width: 360,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    scrollContainer.getBoundingClientRect = () => rectFor(0, 500);
    const content = scrollContainer.querySelector("[data-message-list]");
    const lastLine = content?.lastElementChild;
    expect(lastLine).toBeInstanceOf(HTMLElement);
    (lastLine as HTMLElement).getBoundingClientRect = () => rectFor(900, 100);
    scrollContainer.scrollTop = 0;
    fireEvent.scroll(scrollContainer);

    rerender(<MessageList messages={messages} />);

    expect(scrollContainer.scrollTop).toBe(500);
  });

  it("preserves a parked transcript read position on reveal", () => {
    const scrollContainer = document.createElement("div");
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 500,
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const messages = [
      userMessage("user-1", "earlier request"),
      assistantMessage("assistant-1", "current response"),
    ];
    const { rerender } = render(<MessageList messages={messages} />, {
      container: scrollContainer,
    });

    scrollContainer.scrollTop = 200;
    fireEvent.wheel(scrollContainer, { deltaY: -120 });

    rerender(<MessageList messages={messages} inert />);
    expect(scrollContainer.scrollTop).toBe(200);

    rerender(<MessageList messages={messages} />);
    expect(scrollContainer.scrollTop).toBe(200);
  });
});
