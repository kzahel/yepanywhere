// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import type { RenderTurnGroup } from "../sessionDetail/renderItems";
import {
  deriveVisibleSessionScrollCursor,
  getLatestSeenTurnRenderKey,
} from "../sessionScrollCursor";

function prompt(id: string): RenderItem {
  return { type: "user_prompt", id, content: id, sourceMessages: [] };
}

function answer(id: string): RenderItem {
  return { type: "text", id, text: id, sourceMessages: [] };
}

function elementAt(top: number, bottom: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = vi.fn(
    () =>
      ({
        top,
        bottom,
        left: 0,
        right: 100,
        width: 100,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  return element;
}

const firstPrompt = prompt("prompt-1");
const firstAnswer = answer("answer-1");
const secondPrompt = prompt("prompt-2");
const secondAnswer = answer("answer-2");
const groups: RenderTurnGroup[] = [
  { isUserPrompt: true, items: [firstPrompt] },
  { isUserPrompt: false, items: [firstAnswer] },
  { isUserPrompt: true, items: [secondPrompt] },
  { isUserPrompt: false, items: [secondAnswer] },
];
const allItems = [firstPrompt, firstAnswer, secondPrompt, secondAnswer];

describe("session scroll cursor derivation", () => {
  it("derives the latest visible activity while excluding an active tail", () => {
    const scrollContainer = elementAt(0, 100);
    const rowsById = new Map([
      [firstAnswer.id, elementAt(10, 20)],
      [secondPrompt.id, elementAt(30, 40)],
      [secondAnswer.id, elementAt(80, 90)],
    ]);

    expect(
      deriveVisibleSessionScrollCursor({
        scrollContainer,
        groups,
        rowsById,
        allItems,
        turnActive: true,
      }),
    ).toEqual({
      completedTurn: { id: "prompt-1" },
      seenTurn: { id: "prompt-2", activityIndex: 1 },
      anchor: {
        id: "answer-2",
        topOffset: 80,
        previousId: "prompt-2",
      },
    });
  });

  it("includes a settled tail and exposes its render-change key", () => {
    const scrollContainer = elementAt(0, 100);
    const rowsById = new Map([
      [firstAnswer.id, elementAt(10, 20)],
      [secondAnswer.id, elementAt(80, 90)],
    ]);

    expect(
      deriveVisibleSessionScrollCursor({
        scrollContainer,
        groups,
        rowsById,
        allItems,
        turnActive: false,
      }).completedTurn,
    ).toEqual({ id: "prompt-2" });
    expect(getLatestSeenTurnRenderKey(groups)).toBe("prompt-2:2:answer-2");
  });
});
