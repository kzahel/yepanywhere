// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import {
  assistantMessage,
  assistantToolUseMessage,
  installMessageListTestEnvironment,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";

const galleryRenderCounts = vi.hoisted(() => new Map<string, number>());
const renderItemCounts = vi.hoisted(() => new Map<string, number>());
const exploredRenderCounts = vi.hoisted(() => new Map<string, number>());

vi.mock("../TurnImageGallery", () => ({
  AssistantTurnImageGallery: ({
    children,
    items,
  }: {
    children: ReactNode;
    items: readonly RenderItem[];
  }) => {
    const id = items[0]?.id ?? "empty";
    galleryRenderCounts.set(id, (galleryRenderCounts.get(id) ?? 0) + 1);
    return <div className="assistant-turn">{children}</div>;
  },
  useTurnImageGalleryNavigation: () => null,
}));

vi.mock("../RenderItemComponent", () => ({
  RenderItemComponent: ({ item }: { item: RenderItem }) => {
    renderItemCounts.set(item.id, (renderItemCounts.get(item.id) ?? 0) + 1);
    return <div data-render-id={item.id} />;
  },
}));

vi.mock("../blocks/ExploredToolGroup", () => ({
  ExploredToolGroup: ({ id }: { id: string }) => {
    exploredRenderCounts.set(id, (exploredRenderCounts.get(id) ?? 0) + 1);
    return <div data-explored-id={id} />;
  },
}));

installMessageListTestEnvironment();

function buildToolHistory(turnCount: number): Message[] {
  return Array.from({ length: turnCount }, (_, index) => {
    const readToolId = `read-${index}`;
    const grepToolId = `grep-${index}`;
    return [
      userMessage(`user-${index}`, `request ${index}`),
      assistantToolUseMessage(`assistant-tool-${index}`, [
        {
          type: "tool_use" as const,
          id: readToolId,
          name: "Read",
          input: { file_path: `file-${index}.txt` },
        },
        {
          type: "tool_use" as const,
          id: grepToolId,
          name: "Grep",
          input: { pattern: `needle-${index}` },
        },
      ]),
      {
        type: "user" as const,
        uuid: `tool-result-${index}`,
        message: {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: readToolId,
              content: "read result",
            },
            {
              type: "tool_result" as const,
              tool_use_id: grepToolId,
              content: "grep result",
            },
          ],
        },
      },
      assistantMessage(`assistant-${index}`, `response ${index}`),
    ];
  }).flat();
}

describe("MessageList streaming render boundary", () => {
  afterEach(() => {
    cleanup();
    galleryRenderCounts.clear();
    renderItemCounts.clear();
    exploredRenderCounts.clear();
  });

  it("does not rerender historical assistant turns for a live-tail update", async () => {
    const history = Array.from({ length: 40 }, (_, index) => [
      userMessage(`user-${index}`, `request ${index}`),
      assistantMessage(`assistant-${index}`, `response ${index}`),
    ]).flat();
    const currentPrompt = userMessage("user-live", "current request");
    const initialTail = assistantMessage("assistant-live", "live");
    const updatedTail = assistantMessage("assistant-live", "live update");
    const view = (tail: typeof initialTail) => (
      <MessageList isStreaming messages={[...history, currentPrompt, tail]} />
    );
    const { rerender } = render(view(initialTail));
    await act(async () => {});

    galleryRenderCounts.clear();
    renderItemCounts.clear();
    rerender(view(updatedTail));
    await act(async () => {});

    expect(Object.fromEntries(galleryRenderCounts)).toEqual({
      "assistant-live": 1,
    });
    expect(Object.fromEntries(renderItemCounts)).toEqual({
      "assistant-live": 1,
    });
  });

  it("does not rerender historical explored-tool groups", async () => {
    const history = buildToolHistory(20);
    const currentPrompt = userMessage("user-live", "current request");
    const initialTail = assistantMessage("assistant-live", "live");
    const updatedTail = assistantMessage("assistant-live", "live update");
    const view = (tail: typeof initialTail) => (
      <MessageList isStreaming messages={[...history, currentPrompt, tail]} />
    );
    const { rerender } = render(view(initialTail));
    await act(async () => {});

    expect(exploredRenderCounts.size).toBeGreaterThan(0);
    galleryRenderCounts.clear();
    renderItemCounts.clear();
    exploredRenderCounts.clear();
    rerender(view(updatedTail));
    await act(async () => {});

    expect(Object.fromEntries(galleryRenderCounts)).toEqual({
      "assistant-live": 1,
    });
    expect(Object.fromEntries(renderItemCounts)).toEqual({
      "assistant-live": 1,
    });
    expect(Object.fromEntries(exploredRenderCounts)).toEqual({});
  });

  it("preserves projected Conversation history for a live-tail update", async () => {
    const history = buildToolHistory(20);
    const currentPrompt = userMessage("user-live", "current request");
    const initialTail = assistantMessage("assistant-live", "live");
    const updatedTail = assistantMessage("assistant-live", "live update");
    const view = (tail: typeof initialTail) => (
      <MessageList
        conversationViewEnabledOverride
        isStreaming
        messages={[...history, currentPrompt, tail]}
      />
    );
    const { rerender } = render(view(initialTail));
    await act(async () => {});

    galleryRenderCounts.clear();
    renderItemCounts.clear();
    rerender(view(updatedTail));
    await act(async () => {});

    expect(Object.fromEntries(galleryRenderCounts)).toEqual({
      "assistant-live": 1,
    });
    expect(Object.fromEntries(renderItemCounts)).toEqual({
      "assistant-live": 1,
    });
  });
});
