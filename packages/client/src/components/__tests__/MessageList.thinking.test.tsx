// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import type { Message } from "../../types";
import {
  installMessageListTestEnvironment,
  codexThinkingMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

describe("MessageList thinking rows", () => {
  it.each([0, 16])(
    "cancels thinking-toggle scroll restoration when unmounted after %i ms",
    (elapsed) => {
      vi.useFakeTimers({
        toFake: [
          "setTimeout",
          "clearTimeout",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ],
      });
      const view = render(
        <MessageList
          provider="codex"
          messages={[codexThinkingMessage("thinking-1", "Stored thought")]}
        />,
      );
      act(() => vi.advanceTimersByTime(100));
      fireEvent.click(
        screen.getByRole("button", {
          name: "Hide thinking transcript rows (display only; the agent keeps working)",
        }),
      );
      expect(
        view.container.querySelectorAll("details[data-thinking-block]"),
      ).toHaveLength(0);
      act(() => vi.advanceTimersByTime(elapsed));
      view.unmount();

      // A late restore must neither write detached DOM nor schedule a follow-up
      // state update after the view (and possibly its document) has gone away.
      const writeScroll = vi.fn();
      Object.defineProperty(view.container, "scrollTop", {
        configurable: true,
        get: () => 0,
        set: writeScroll,
      });
      act(() => vi.advanceTimersByTime(100));
      expect(writeScroll).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("renders Codex reasoning summaries as collapsed thinking blocks", () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "**Checking instructions**\n\nI need to inspect the repo.",
          ),
        ]}
      />,
    );

    expect(container.querySelector("[data-thinking-block]")).not.toBeNull();
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByLabelText("Expand thinking")).toBeTruthy();
    expect(container.querySelector("[data-text-block-assistant]")).toBeNull();
  });

  it("expands a collapsed thinking block from the timeline hit target", async () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "**Checking instructions**\n\nI need to inspect the repo.",
          ),
        ]}
      />,
    );

    const thinkingBlock = container.querySelector<HTMLDetailsElement>(
      "details[data-thinking-block]",
    );
    const dot = container.querySelector<HTMLElement>(
      "[data-thinking-block] [data-timeline-dot-btn]",
    );
    expect(thinkingBlock?.open).toBe(false);
    expect(dot).toBeTruthy();
    expect(container.querySelector(".thinking-dot-btn")).toBeNull();

    fireEvent.click(dot as HTMLElement);

    await waitFor(() => expect(thinkingBlock?.open).toBe(true));
  });

  it("auto-expands newly observed Codex thinking blocks", () => {
    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );

    let thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details[data-thinking-block]",
    );
    expect(thinkingBlocks).toHaveLength(0);

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "First active thought",
            "2026-04-25T00:00:00.000Z",
          ),
        ]}
      />,
    );

    thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details[data-thinking-block]",
    );
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]?.open).toBe(true);

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "First active thought",
            "2026-04-25T00:00:00.000Z",
          ),
          codexThinkingMessage(
            "thinking-2",
            "Second active thought",
            "2026-04-25T00:00:02.000Z",
          ),
        ]}
      />,
    );

    thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details[data-thinking-block]",
    );
    expect(thinkingBlocks).toHaveLength(2);
    expect(thinkingBlocks[0]?.open).toBe(true);
    expect(thinkingBlocks[1]?.open).toBe(true);
  });

  it("does not auto-expand complete Codex thinking blocks on load", () => {
    const { container } = render(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Earlier complete thought",
            "2026-04-25T00:00:00.000Z",
          ),
          codexThinkingMessage(
            "thinking-2",
            "Latest complete thought",
            "2026-04-25T00:00:02.000Z",
          ),
        ]}
      />,
    );

    const thinkingBlocks = container.querySelectorAll<HTMLDetailsElement>(
      "details[data-thinking-block]",
    );
    expect(thinkingBlocks).toHaveLength(2);
    expect(thinkingBlocks[0]?.open).toBe(false);
    expect(thinkingBlocks[1]?.open).toBe(false);
  });

  it("auto-expands historical pi thinking blocks", () => {
    const { container } = render(
      <MessageList
        provider="pi"
        isProcessing={false}
        messages={[
          {
            type: "assistant",
            uuid: "pi-thinking-1",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Historical pi thought" },
                { type: "text", text: "Visible pi answer" },
              ],
            },
          } as Message,
        ]}
      />,
    );

    const thinkingBlock = container.querySelector<HTMLDetailsElement>(
      "details[data-thinking-block]",
    );
    expect(thinkingBlock).not.toBeNull();
    expect(thinkingBlock?.open).toBe(true);
  });

  it("restores hidden historical pi thinking blocks expanded", () => {
    window.localStorage.setItem(UI_KEYS.sessionThinkingVisible, "false");
    const { container } = render(
      <MessageList
        provider="pi"
        messages={[codexThinkingMessage("pi-thinking-1", "Stored pi thought")]}
      />,
    );

    expect(
      container.querySelectorAll("details[data-thinking-block]"),
    ).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show hidden thinking transcript rows",
      }),
    );

    const thinkingBlock = container.querySelector<HTMLDetailsElement>(
      "details[data-thinking-block]",
    );
    expect(thinkingBlock).not.toBeNull();
    expect(thinkingBlock?.open).toBe(true);
  });

  it("keeps an auto-expanded thinking block open after completion", async () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <MessageList provider="codex" isProcessing={true} messages={[]} />,
    );

    rerender(
      <MessageList
        provider="codex"
        isProcessing={true}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Completing thought",
            "2026-04-25T00:00:00.000Z",
            true,
          ),
        ]}
      />,
    );

    expect(
      container.querySelector<HTMLDetailsElement>(
        "details[data-thinking-block]",
      )?.open,
    ).toBe(true);

    rerender(
      <MessageList
        provider="codex"
        isProcessing={false}
        messages={[
          codexThinkingMessage(
            "thinking-1",
            "Completing thought",
            "2026-04-25T00:00:00.000Z",
          ),
        ]}
      />,
    );

    expect(
      container.querySelector<HTMLDetailsElement>(
        "details[data-thinking-block]",
      )?.open,
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });

    expect(
      container.querySelector<HTMLDetailsElement>(
        "details[data-thinking-block]",
      )?.open,
    ).toBe(true);
  });

  it("hides and restores thinking transcript rows from the compact toggle", () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage("thinking-1", "First stored thought"),
          codexThinkingMessage("thinking-2", "Second stored thought"),
        ]}
      />,
    );

    expect(
      container.querySelectorAll("details[data-thinking-block]"),
    ).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide thinking transcript rows (display only; the agent keeps working)",
      }),
    );

    expect(
      container.querySelectorAll("details[data-thinking-block]"),
    ).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show hidden thinking transcript rows",
      }),
    );

    expect(
      container.querySelectorAll("details[data-thinking-block]"),
    ).toHaveLength(2);
  });

  it("hides and restores thinking transcript rows with Ctrl+O", async () => {
    const { container } = render(
      <MessageList
        provider="codex"
        messages={[
          codexThinkingMessage("thinking-1", "First stored thought"),
          codexThinkingMessage("thinking-2", "Second stored thought"),
        ]}
      />,
    );

    expect(
      container.querySelectorAll("details[data-thinking-block]"),
    ).toHaveLength(2);

    fireEvent.keyDown(window, {
      key: "o",
      code: "KeyO",
      ctrlKey: true,
    });

    await waitFor(() =>
      expect(
        container.querySelectorAll("details[data-thinking-block]"),
      ).toHaveLength(0),
    );

    fireEvent.keyDown(window, {
      key: "o",
      code: "KeyO",
      ctrlKey: true,
    });

    await waitFor(() =>
      expect(
        container.querySelectorAll("details[data-thinking-block]"),
      ).toHaveLength(2),
    );
  });
});
