// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTextareaContentsUndoably,
  countDraftLines,
  getInsertedTextForEdit,
  isFullPaneComposerShortcut,
  replaceTextareaRangeUndoably,
  resizeComposerTextarea,
  scrollCollapsedTextareaToCursor,
} from "../composerTextarea";

const originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "visualViewport",
);

function makeTextarea(value = ""): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  document.body.append(textarea);
  textarea.focus();
  return textarea;
}

function rect(height: number): DOMRect {
  return {
    top: 0,
    bottom: height,
    left: 0,
    right: 100,
    width: 100,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalVisualViewportDescriptor) {
    Object.defineProperty(
      window,
      "visualViewport",
      originalVisualViewportDescriptor,
    );
  } else {
    Reflect.deleteProperty(window, "visualViewport");
  }
});

describe("composer textarea edits", () => {
  it("clears textarea contents through the fallback edit path", () => {
    const textarea = makeTextarea("undoable draft");
    const onInput = vi.fn();
    textarea.addEventListener("input", onInput);

    clearTextareaContentsUndoably(textarea);

    expect(textarea.value).toBe("");
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("replaces a textarea range through the fallback edit path", () => {
    const textarea = makeTextarea("hello world");

    replaceTextareaRangeUndoably(textarea, 6, 11, "there");

    expect(textarea.value).toBe("hello there");
    expect(textarea.selectionStart).toBe("hello there".length);
    expect(textarea.selectionEnd).toBe("hello there".length);
  });

  it("computes inserted text for input edit metadata", () => {
    expect(getInsertedTextForEdit("hello world", "hello there", 6, 11)).toBe(
      "there",
    );
    expect(getInsertedTextForEdit("abc", "ab", 2, 3)).toBe("");
    expect(getInsertedTextForEdit("abc", "abXYc", 2, 2)).toBe("XY");
  });
});

describe("composer textarea sizing", () => {
  it("resizes expanded textareas within the viewport cap", () => {
    const composer = document.createElement("div");
    composer.className = "message-input";
    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    composer.append(textarea);
    document.body.append(composer);

    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderBottomWidth: "0px",
      borderTopWidth: "0px",
      fontSize: "10px",
      lineHeight: "20px",
      paddingBottom: "2px",
      paddingTop: "2px",
    } as CSSStyleDeclaration);
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { height: 200 },
    });
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 120,
    });
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(40));
    vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue(rect(30));

    resizeComposerTextarea(textarea, false);

    expect(textarea.style.height).toBe("90px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("restores browser-managed textarea sizing while collapsed", () => {
    const textarea = makeTextarea();
    textarea.style.height = "80px";
    textarea.style.overflowY = "auto";

    resizeComposerTextarea(textarea, true);

    expect(textarea.style.height).toBe("");
    expect(textarea.style.overflowY).toBe("");
  });

  it("keeps one spare line while a full-pane draft grows", () => {
    const host = document.createElement("div");
    host.dataset.composerFullPane = "true";
    const composer = document.createElement("div");
    composer.dataset.composerShell = "true";
    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    composer.append(textarea);
    host.append(composer);
    document.body.append(host);

    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderBottomWidth: "0px",
      borderTopWidth: "0px",
      fontSize: "10px",
      lineHeight: "20px",
      paddingBottom: "0px",
      paddingTop: "0px",
    } as CSSStyleDeclaration);
    let scrollHeight = 100;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(240));
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(70));
    vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue(rect(60));

    expect(resizeComposerTextarea(textarea, false, true)).toEqual({
      overflowed: false,
    });
    expect(textarea.style.height).toBe("120px");
    expect(textarea.style.overflowY).toBe("hidden");

    scrollHeight = 120;
    expect(resizeComposerTextarea(textarea, false, true)).toEqual({
      overflowed: false,
    });
    expect(textarea.style.height).toBe("140px");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("caps a full-pane draft at its host and then scrolls", () => {
    const host = document.createElement("div");
    host.dataset.composerFullPane = "true";
    const composer = document.createElement("div");
    composer.dataset.composerShell = "true";
    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    composer.append(textarea);
    host.append(composer);
    document.body.append(host);

    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderBottomWidth: "0px",
      borderTopWidth: "0px",
      fontSize: "10px",
      lineHeight: "20px",
      paddingBottom: "0px",
      paddingTop: "0px",
    } as CSSStyleDeclaration);
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 220,
    });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(180));
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(90));
    vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue(rect(60));

    expect(resizeComposerTextarea(textarea, false, true)).toEqual({
      overflowed: true,
    });
    expect(textarea.style.height).toBe("150px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("uses the session split as the in-session growth limit", () => {
    const split = document.createElement("div");
    split.setAttribute("data-session-split", "");
    const input = document.createElement("div");
    input.setAttribute("data-session-input", "");
    const host = document.createElement("div");
    host.dataset.composerFullPane = "true";
    const composer = document.createElement("div");
    composer.dataset.composerShell = "true";
    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    composer.append(textarea);
    host.append(composer);
    input.append(host);
    split.append(input);
    document.body.append(split);

    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderBottomWidth: "0px",
      borderTopWidth: "0px",
      fontSize: "10px",
      lineHeight: "20px",
      paddingBottom: "0px",
      paddingTop: "0px",
    } as CSSStyleDeclaration);
    let scrollHeight = 120;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    vi.spyOn(split, "getBoundingClientRect").mockReturnValue(rect(400));
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(rect(150));
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect(120));
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(100));
    vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue(rect(80));

    expect(resizeComposerTextarea(textarea, false, true)).toEqual({
      overflowed: false,
    });
    expect(textarea.style.height).toBe("140px");

    scrollHeight = 340;
    expect(resizeComposerTextarea(textarea, false, true)).toEqual({
      overflowed: true,
    });
    expect(textarea.style.height).toBe("350px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("scrolls a collapsed textarea to the cursor line", () => {
    const textarea = makeTextarea("one\ntwo\nthree\nfour\nfive");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      fontSize: "10px",
      lineHeight: "20px",
    } as CSSStyleDeclaration);
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(textarea, "clientHeight", {
      configurable: true,
      value: 28,
    });

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    scrollCollapsedTextareaToCursor(textarea);

    expect(textarea.scrollTop).toBe(152);
    expect(countDraftLines("one\r\ntwo\nthree")).toBe(3);
  });
});

describe("full-pane composer shortcut", () => {
  it("recognizes only Ctrl+U", () => {
    expect(
      isFullPaneComposerShortcut({
        key: "U",
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isFullPaneComposerShortcut({
        key: "u",
        ctrlKey: true,
        shiftKey: true,
        metaKey: false,
        altKey: false,
      }),
    ).toBe(false);
  });
});
