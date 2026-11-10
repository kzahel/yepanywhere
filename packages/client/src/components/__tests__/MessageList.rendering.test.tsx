// @vitest-environment jsdom

import { Profiler, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { SchemaValidationProvider } from "../../contexts/SchemaValidationContext";
import { SourceRuntimeProvider } from "../../contexts/SourceRuntimeContext";
import { ToastProvider } from "../../contexts/ToastContext";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import { buildCorrectionText } from "../../lib/correctionText";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { UI_KEYS } from "../../lib/storageKeys";
import { FakeSourceTransport } from "../../lib/transport";
import { createTranscriptPositionStore } from "../../lib/transcriptPositionStore";
import { setConversationViewPreference } from "../../hooks/useConversationView";
import {
  assistantMessage,
  assistantToolUseMessage,
  codexThinkingMessage,
  installMessageListTestEnvironment,
  userMessage,
} from "./MessageList.test-support";
import { createComposerDraftSignal } from "../../lib/composerDraftSignal";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { I18nProvider } from "../../i18n";
import type { Message } from "../../types";
import { MessageList } from "../MessageList";
import galleryStyles from "../TurnImageGallery.module.css";

installMessageListTestEnvironment();

function ToolProviders({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <SchemaValidationProvider>{children}</SchemaValidationProvider>
    </ToastProvider>
  );
}

describe("MessageList rendering", () => {
  const galleryMediaHtml = (label: string, path: string) =>
    `<span class="local-media-link-group"><button type="button" class="local-media-inline-toggle" data-media-path="${path}" data-media-type="image" data-expanded="false" aria-label="Expand image" aria-expanded="false">+</button><a href="/api/local-image?path=${encodeURIComponent(path)}" class="local-media-link" data-media-type="image" data-ya-path="${path}" data-ya-media-type="image">${label}<span class="local-media-type">(image)</span></a></span><span class="local-media-inline-preview" data-media-path="${path}" data-media-type="image" data-expanded="false"></span>`;
  const transcriptRenderWeight = (container: HTMLElement) =>
    Number(
      container
        .querySelector(".message-list")
        ?.getAttribute("data-transcript-render-weight") ?? 0,
    );

  it("offers a real after fork on the first turn and before on later turns", () => {
    const onForkBefore = vi.fn();
    const onForkAfter = vi.fn();
    render(
      <MessageList
        messages={[
          userMessage("user-1", "First request"),
          assistantMessage("assistant-1", "First response"),
          userMessage("user-2", "Second request"),
          assistantMessage("assistant-2", "Second response"),
        ]}
        onForkBeforeUserMessage={onForkBefore}
        onForkAfterUserMessage={onForkAfter}
        onForkAfterSummaryUserMessage={vi.fn()}
      />,
    );

    const triggers = screen.getAllByRole("button", {
      name: "Fork from this turn",
    });
    fireEvent.click(triggers[0]!);
    expect(
      screen.queryByRole("menuitem", { name: "Before this turn" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "After this turn" }));
    expect(onForkAfter).toHaveBeenCalledWith("user-1");

    fireEvent.click(triggers[1]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Before this turn" }));
    expect(onForkBefore).toHaveBeenCalledWith("user-2");
  });

  it("groups turn images while preserving bidirectional text-link navigation", () => {
    window.localStorage.setItem(UI_KEYS.inlineMediaExpandedByDefault, "true");
    invalidateLocalStorageValues();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(Element.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    let pointerFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      pointerFrame = callback;
      return 1;
    });

    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "show both"),
          assistantMessage("assistant-1", "Two results"),
        ]}
        markdownAugments={{
          "assistant-1": {
            html: `<p>Two results: ${galleryMediaHtml("Desktop result", "/repo/desktop.png")} and ${galleryMediaHtml("Phone result", "/repo/phone.png")}</p>`,
          },
        }}
      />,
      { wrapper: I18nProvider },
    );

    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeTruthy();
    const sourceToggles = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".local-media-inline-toggle",
      ),
    );
    expect(sourceToggles).toHaveLength(2);
    for (const toggle of sourceToggles) {
      expect(toggle.textContent).toBe("−");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-label")).toBe("Collapse gallery");
    }
    const galleryAction = container.querySelector<HTMLButtonElement>(
      ".turn-image-gallery-inline-action",
    );
    expect(galleryAction?.textContent).toBe("−Gallery");
    expect(galleryAction?.getAttribute("aria-label")).toBe("Collapse gallery");
    expect(container.querySelectorAll(`.${galleryStyles.item}`)).toHaveLength(
      2,
    );
    expect(
      container.querySelectorAll(".text-block-content a.local-media-link"),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll(
        ".local-media-inline-preview[data-expanded='false']",
      ),
    ).toHaveLength(2);

    const galleryItems = container.querySelectorAll(`.${galleryStyles.item}`);
    fireEvent.pointerEnter(galleryItems[1] as HTMLElement);
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("Phone result");

    galleryItems[0]!.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 100,
          height: 100,
          left: 0,
          right: 100,
          top: 0,
          width: 100,
        }) as DOMRect,
    );
    galleryItems[1]!.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 100,
          height: 100,
          left: 140,
          right: 240,
          top: 0,
          width: 100,
        }) as DOMRect,
    );
    const movePointer = (clientX: number, clientY: number) => {
      const event = new MouseEvent("pointermove", {
        bubbles: true,
        clientX,
        clientY,
      });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      fireEvent(window, event);
      act(() => pointerFrame?.(0));
    };
    movePointer(110, 500);
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("Desktop result");
    movePointer(210, 500);
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("Phone result");

    const phoneLink = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a.local-media-link"),
    ).find((link) => link.textContent?.includes("Phone result"));
    fireEvent.click(phoneLink as HTMLAnchorElement);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByRole("dialog").querySelector(".modal-title")?.textContent,
    ).toBe("phone.png");
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeTruthy();
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("Phone result");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(
      screen.getByRole("dialog").querySelector(".modal-title")?.textContent,
    ).toBe("desktop.png");
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(
      screen.getByRole("dialog").querySelector(".modal-title")?.textContent,
    ).toBe("phone.png");
    fireEvent.click(
      document.querySelector(".modal-close") as HTMLButtonElement,
    );

    fireEvent.click(
      container.querySelector(`.${galleryStyles.caption}`) as HTMLButtonElement,
    );
    expect(document.activeElement).toBe(phoneLink);

    fireEvent.click(sourceToggles[0] as HTMLButtonElement);
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();
    expect(sourceToggles[0]?.textContent).toBe("+");
    expect(sourceToggles[1]?.textContent).toBe("+");
    expect(galleryAction?.textContent).toBe("+Gallery");
    expect(galleryAction?.getAttribute("aria-label")).toBe("Expand gallery");
    expect(
      phoneLink?.closest(".local-media-link-group")?.contains(galleryAction),
    ).toBe(true);
    fireEvent.click(galleryAction as HTMLButtonElement);
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeTruthy();
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("Phone result");

    fireEvent.click(
      container.querySelector(`.${galleryStyles.dismiss}`) as HTMLButtonElement,
    );
    fireEvent.click(sourceToggles[1] as HTMLButtonElement);
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeTruthy();
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("Phone result");
  });

  it("offers a turn gallery when inline media does not start expanded", () => {
    window.localStorage.setItem(UI_KEYS.inlineMediaExpandedByDefault, "false");
    window.localStorage.setItem(UI_KEYS.compactMultiImageGalleries, "true");
    invalidateLocalStorageValues();
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    const { container } = render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Two results")]}
        markdownAugments={{
          "assistant-1": {
            html: `<p>${galleryMediaHtml("One", "/repo/one.png")} ${galleryMediaHtml("Two", "/repo/two.png")}</p>`,
          },
        }}
      />,
    );

    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();
    expect(
      container.querySelectorAll(
        ".local-media-inline-preview[data-expanded='false']",
      ),
    ).toHaveLength(2);
    const links =
      container.querySelectorAll<HTMLAnchorElement>("a.local-media-link");
    const galleryAction = container.querySelector<HTMLButtonElement>(
      ".turn-image-gallery-inline-action",
    );
    expect(galleryAction?.getAttribute("aria-label")).toBe("Expand gallery");
    expect(galleryAction?.textContent).toBe("+Gallery");
    expect(
      links[1]?.closest(".local-media-link-group")?.contains(galleryAction),
    ).toBe(true);

    fireEvent.click(galleryAction as HTMLButtonElement);
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeTruthy();
    expect(galleryAction?.getAttribute("aria-label")).toBe("Collapse gallery");
    expect(galleryAction?.textContent).toBe("−Gallery");
    // Centering the shown image moves only the gallery's own scroller; the
    // transcript around it must never be scrolled sideways.
    expect(scrollTo.mock.contexts).toContain(
      container.querySelector(`.${galleryStyles.rows}`),
    );
    expect(scrollIntoView).toHaveBeenCalled();
    for (const [options] of scrollIntoView.mock.calls) {
      expect(options).toMatchObject({ inline: "nearest" });
    }

    fireEvent.pointerEnter(
      container.querySelectorAll(`.${galleryStyles.item}`)[1] as HTMLElement,
    );
    fireEvent.click(galleryAction as HTMLButtonElement);
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();
    fireEvent.click(
      container.querySelectorAll<HTMLButtonElement>(
        ".local-media-inline-toggle",
      )[0] as HTMLButtonElement,
    );
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("One");

    fireEvent.click(galleryAction as HTMLButtonElement);
    fireEvent.click(galleryAction as HTMLButtonElement);
    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("One");
  });

  it("opens a source image with ring navigation without expanding its gallery", () => {
    window.localStorage.setItem(UI_KEYS.inlineMediaExpandedByDefault, "false");
    window.localStorage.setItem(UI_KEYS.compactMultiImageGalleries, "true");
    invalidateLocalStorageValues();

    const { container } = render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Two results")]}
        markdownAugments={{
          "assistant-1": {
            html: `<p>${galleryMediaHtml("One", "/repo/one.png")} ${galleryMediaHtml("Two", "/repo/two.png")}</p>`,
          },
        }}
      />,
      { wrapper: I18nProvider },
    );
    const links =
      container.querySelectorAll<HTMLAnchorElement>("a.local-media-link");

    fireEvent.click(links[0] as HTMLAnchorElement);
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();
    expect(
      screen.getByRole("dialog").querySelector(".modal-title")?.textContent,
    ).toBe("one.png");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();
    expect(
      screen.getByRole("dialog").querySelector(".modal-title")?.textContent,
    ).toBe("two.png");

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(
      screen.getByRole("dialog").querySelector(".modal-title")?.textContent,
    ).toBe("one.png");

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(
      screen.getByRole("dialog").querySelector(".modal-title")?.textContent,
    ).toBe("two.png");

    fireEvent.click(
      document.querySelector(".modal-close") as HTMLButtonElement,
    );
    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();
  });

  it("keeps independent inline previews when compact galleries are disabled", () => {
    window.localStorage.setItem(UI_KEYS.inlineMediaExpandedByDefault, "true");
    window.localStorage.setItem(UI_KEYS.compactMultiImageGalleries, "false");
    invalidateLocalStorageValues();

    const { container } = render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Two results")]}
        markdownAugments={{
          "assistant-1": {
            html: `<p>${galleryMediaHtml("One", "/repo/one.png")} ${galleryMediaHtml("Two", "/repo/two.png")}</p>`,
          },
        }}
      />,
    );

    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();
    expect(
      container.querySelector(".turn-image-gallery-inline-action"),
    ).toBeNull();
    expect(
      container.querySelectorAll(
        ".local-media-inline-preview[data-expanded='true']",
      ),
    ).toHaveLength(2);
  });

  it("forms the gallery when final streamed markdown arrives", () => {
    window.localStorage.setItem(UI_KEYS.inlineMediaExpandedByDefault, "true");
    invalidateLocalStorageValues();
    const messages = [assistantMessage("assistant-1", "Two results")];
    const { container, rerender } = render(<MessageList messages={messages} />);

    expect(container.querySelector(`.${galleryStyles.gallery}`)).toBeNull();

    rerender(
      <MessageList
        messages={messages}
        markdownAugments={{
          "assistant-1": {
            html: `<p>${galleryMediaHtml("One", "/repo/one.png")} ${galleryMediaHtml("Two", "/repo/two.png")}</p>`,
          },
        }}
      />,
    );

    expect(container.querySelectorAll(`.${galleryStyles.item}`)).toHaveLength(
      2,
    );
    expect(
      container.querySelectorAll(".text-block-content a.local-media-link"),
    ).toHaveLength(2);
  });

  it("features the image nearest the gallery center after a swipe", () => {
    window.localStorage.setItem(UI_KEYS.inlineMediaExpandedByDefault, "true");
    invalidateLocalStorageValues();
    let scrollFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scrollFrame = callback;
      return 1;
    });

    const { container } = render(
      <MessageList
        messages={[assistantMessage("assistant-1", "Two results")]}
        markdownAugments={{
          "assistant-1": {
            html: `<p>${galleryMediaHtml("One", "/repo/one.png")} ${galleryMediaHtml("Two", "/repo/two.png")}</p>`,
          },
        }}
      />,
    );
    const rows = container.querySelector(
      `.${galleryStyles.rows}`,
    ) as HTMLDivElement;
    const items = Array.from(
      container.querySelectorAll<HTMLElement>(`.${galleryStyles.item}`),
    );
    Object.defineProperty(rows, "clientWidth", {
      configurable: true,
      value: 300,
    });
    rows.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 300 }) as DOMRect,
    );
    items[0]!.getBoundingClientRect = vi.fn(
      () => ({ left: 0, width: 100 }) as DOMRect,
    );
    items[1]!.getBoundingClientRect = vi.fn(
      () => ({ left: 130, width: 100 }) as DOMRect,
    );

    fireEvent.scroll(rows);
    act(() => scrollFrame?.(0));

    expect(
      container.querySelector(`.${galleryStyles.caption} > span`)?.textContent,
    ).toBe("Two");
  });

  it("does not commit a 1,000-row transcript for draft changes", () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "false");
    const composerDraftSignal = createComposerDraftSignal();
    const onRender = vi.fn();
    const messages = Array.from({ length: 1_000 }, (_, index) =>
      index % 2 === 0
        ? userMessage(`user-${index}`, `request ${index}`)
        : assistantMessage(`assistant-${index}`, `response ${index}`),
    );

    const { container } = render(
      <Profiler id="transcript" onRender={onRender}>
        <MessageList
          messages={messages}
          composerDraftSignal={composerDraftSignal}
        />
      </Profiler>,
    );
    expect(
      container.querySelectorAll("[data-render-id]").length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-render-id]").length,
    ).toBeLessThanOrEqual(48);
    const initialCommitCount = onRender.mock.calls.length;

    act(() => {
      composerDraftSignal.publishDraftChange("a", {
        mayAffectQuoteAnchors: false,
      });
      composerDraftSignal.publishDraftChange("ab", {
        mayAffectQuoteAnchors: false,
      });
      composerDraftSignal.publishDraftChange("ab ", {
        mayAffectQuoteAnchors: false,
      });
      composerDraftSignal.publishDraftChange("ab \n", {
        mayAffectQuoteAnchors: true,
      });
      composerDraftSignal.publishDraftChange("ab", {
        mayAffectQuoteAnchors: true,
      });
      composerDraftSignal.publishDraftChange("", {
        mayAffectQuoteAnchors: true,
      });
    });

    expect(onRender).toHaveBeenCalledTimes(initialCommitCount);
  });

  it("publishes only the latest hovered row without committing the transcript", () => {
    let pendingFrame: FrameRequestCallback | null = null;
    const transcriptPositionStore = createTranscriptPositionStore({
      request: (callback) => {
        pendingFrame = callback;
        return 1;
      },
      cancel: () => {
        pendingFrame = null;
      },
    });
    const listener = vi.fn();
    transcriptPositionStore.subscribe(listener);
    const onRender = vi.fn();
    const firstTimestamp = "2026-04-26T12:00:00.000Z";
    const latestTimestamp = "2026-04-26T12:01:00.000Z";
    const { container } = render(
      <Profiler id="transcript" onRender={onRender}>
        <MessageList
          messages={[
            userMessage("user-1", "request", firstTimestamp),
            assistantMessage("assistant-1", "response", latestTimestamp),
          ]}
          transcriptPositionStore={transcriptPositionStore}
        />
      </Profiler>,
    );
    const initialCommitCount = onRender.mock.calls.length;
    const messageList = container.querySelector<HTMLElement>(".message-list");
    const firstRow = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const latestRow = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );

    fireEvent.pointerOver(firstRow as HTMLElement);
    fireEvent.pointerOver(latestRow as HTMLElement);
    expect(transcriptPositionStore.getSnapshot()).toBeNull();
    act(() => {
      const frame = pendingFrame;
      pendingFrame = null;
      frame?.(0);
    });

    expect(transcriptPositionStore.getSnapshot()).toBe(
      new Date(latestTimestamp).getTime(),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onRender).toHaveBeenCalledTimes(initialCommitCount);

    fireEvent.pointerLeave(messageList as HTMLElement);
    act(() => {
      const frame = pendingFrame;
      pendingFrame = null;
      frame?.(0);
    });
    expect(transcriptPositionStore.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(onRender).toHaveBeenCalledTimes(initialCommitCount);
  });

  it("defers tail updates but commits prefix changes synchronously", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const current = userMessage("user-current", "Current request");

    act(() => {
      root.render(<MessageList messages={[current]} />);
    });

    act(() => {
      flushSync(() => {
        root.render(
          <MessageList
            messages={[
              current,
              assistantMessage("assistant-live", "Live tail update"),
            ]}
          />,
        );
      });
      expect(screen.queryByText("Live tail update")).toBeNull();
    });
    expect(screen.getByText("Live tail update")).toBeTruthy();

    act(() => {
      flushSync(() => {
        root.render(
          <MessageList
            messages={[
              userMessage("user-older", "Older request"),
              current,
              assistantMessage("assistant-live", "Live tail update"),
            ]}
            olderMessagesCursor="user-older"
          />,
        );
      });
      expect(screen.getByText("Older request")).toBeTruthy();
    });

    act(() => root.unmount());
    host.remove();
  });

  it("condenses and restores routine activity in Conversation view", () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "true");
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect this", "2026-07-28T07:00:00.000Z"),
          codexThinkingMessage(
            "thinking-1",
            "private planning",
            "2026-07-28T07:00:01.000Z",
          ),
          assistantMessage(
            "assistant-1",
            "Visible answer",
            "2026-07-28T07:00:02.000Z",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Visible answer")).toBeTruthy();
    expect(screen.queryByText("private planning")).toBeNull();
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).toBeNull();
    const summary = container.querySelector(
      ".conversation-activity-summary",
    ) as HTMLButtonElement | null;
    expect(summary).toBeTruthy();
    expect(summary?.textContent).toContain("1 activity hidden");

    fireEvent.click(summary as HTMLButtonElement);

    expect(screen.getByText("private planning")).toBeTruthy();
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).toBeNull();
    expect(
      container
        .querySelector(".conversation-activity-summary")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("ignores a touch-adjusted activity click that began outside the pill", () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "true");
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect this", "2026-07-28T07:00:00.000Z"),
          codexThinkingMessage(
            "thinking-1",
            "private planning",
            "2026-07-28T07:00:01.000Z",
          ),
          assistantMessage(
            "assistant-1",
            "Visible answer",
            "2026-07-28T07:00:02.000Z",
          ),
        ]}
      />,
    );
    const summary = container.querySelector(
      ".conversation-activity-summary",
    ) as HTMLButtonElement;
    vi.spyOn(summary, "getBoundingClientRect").mockReturnValue({
      bottom: 134,
      height: 34,
      left: 20,
      right: 270,
      top: 100,
      width: 250,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    });
    const fireTouchPointer = (
      type: "pointerdown" | "pointerup",
      clientY: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: 100,
        clientY,
      });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      fireEvent(summary, event);
    };

    // Chrome may retarget a coarse touch from the neighboring blank area onto
    // the button and then clamp the synthesized click to its painted edge.
    fireTouchPointer("pointerdown", 96);
    fireTouchPointer("pointerup", 96);
    fireEvent.click(summary, { clientX: 100, clientY: 100 });

    expect(
      container
        .querySelector(".conversation-activity-summary")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText("private planning")).toBeNull();

    fireTouchPointer("pointerdown", 110);
    fireTouchPointer("pointerup", 110);
    fireEvent.click(summary, { clientX: 100, clientY: 110 });

    expect(
      container
        .querySelector(".conversation-activity-summary")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("private planning")).toBeTruthy();
  });

  it("remembers tool-media disclosure across Conversation view toggles", () => {
    const transport = new FakeSourceTransport({
      fetchBlob: vi.fn(() => new Promise<Blob>(() => {})),
    });
    const runtime: YaSourceRuntime = {
      sourceKey: asClientSummarySourceKey("test:remembered-disclosure"),
      transport,
      api: {} as YaSourceRuntime["api"],
      summary: {} as YaSourceRuntime["summary"],
      sessionDetails: {} as YaSourceRuntime["sessionDetails"],
    };
    const messages: Message[] = [
      userMessage("user-media", "inspect these"),
      codexThinkingMessage("thinking-media", "checking images"),
      assistantToolUseMessage("assistant-media", [
        {
          type: "tool_use",
          id: "tool-media",
          name: "ViewImage",
          input: { path: "/repo/first.png" },
        },
      ]),
      {
        type: "user",
        uuid: "tool-result-media",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-media",
              content: "",
            },
          ],
        },
        toolResultMedia: [
          {
            state: "stored",
            toolCallId: "tool-media",
            id: "media-a",
            mimeType: "image/png",
            byteLength: 128,
            filename: "first.png",
          },
        ],
      },
      assistantMessage("assistant-media-answer", "Done"),
    ];
    const view = (conversationViewEnabled: boolean) => (
      <SourceRuntimeProvider runtime={runtime}>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/repo"
          sessionId="session-1"
        >
          <MessageList
            conversationViewEnabledOverride={conversationViewEnabled}
            conversationViewStateKey="session-1"
            messages={messages}
          />
        </SessionMetadataProvider>
      </SourceRuntimeProvider>
    );
    const { rerender } = render(view(false), { wrapper: ToolProviders });

    fireEvent.click(
      screen.getByRole("button", { name: "toolResultMediaExpand" }),
    );
    expect(
      screen.getByRole("button", { name: "toolResultMediaCollapse" }),
    ).toBeTruthy();

    rerender(view(true));
    expect(
      screen.getByRole("button", { name: "toolResultMediaCollapse" }),
    ).toBeTruthy();

    rerender(view(false));
    expect(
      screen.getByRole("button", { name: "toolResultMediaCollapse" }),
    ).toBeTruthy();
  });

  it("remembers ordinary tool-row disclosure across Conversation view toggles", () => {
    const messages: Message[] = [
      userMessage("user-tool", "run the custom tool"),
      assistantToolUseMessage("assistant-tool", [
        {
          type: "tool_use",
          id: "tool-custom",
          name: "CustomTool",
          input: { query: "status" },
        },
      ]),
      {
        type: "user",
        uuid: "tool-result-custom",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-custom",
              content: "custom result",
            },
          ],
        },
      },
      assistantMessage("assistant-tool-answer", "Done"),
    ];
    const view = (
      conversationViewEnabled: boolean,
      visibleMessages = messages,
      activeWindowTrimRevision = 0,
    ) => (
      <MessageList
        activeWindowTrimRevision={activeWindowTrimRevision}
        conversationViewEnabledOverride={conversationViewEnabled}
        conversationViewStateKey="session-tool"
        messages={visibleMessages}
      />
    );
    const { container, rerender } = render(view(false), {
      wrapper: ToolProviders,
    });
    const toolRow = () =>
      container.querySelector<HTMLElement>(
        '[data-render-id="tool-custom"] .tool-row',
      );

    fireEvent.click(
      container.querySelector<HTMLElement>(
        '[data-render-id="tool-custom"] .tool-row-header',
      ) as HTMLElement,
    );
    expect(toolRow()?.classList.contains("expanded")).toBe(true);

    rerender(view(true));
    expect(toolRow()).toBeNull();

    rerender(view(false));
    expect(toolRow()?.classList.contains("expanded")).toBe(true);

    rerender(view(false, [], 1));
    rerender(view(false, messages, 1));
    expect(toolRow()?.classList.contains("expanded")).toBe(false);
  });

  it("prunes explored disclosure only after its semantic owner leaves the loaded window", () => {
    const toolUse = (id: string, name: string, input: unknown) => ({
      type: "tool_use" as const,
      id,
      name,
      input,
    });
    const read = toolUse("read-owner", "Read", { file_path: "README.md" });
    const grep = toolUse("grep-adjacent", "Grep", { pattern: "needle" });
    const list = toolUse("list-appended", "list_dir", { path: "src" });
    const messagesFor = (tools: Array<typeof read>) => [
      userMessage("user-exploration", "inspect the project"),
      assistantToolUseMessage("assistant-exploration", tools),
    ];
    const view = (tools: Array<typeof read>, activeWindowTrimRevision = 0) => (
      <MessageList
        activeWindowTrimRevision={activeWindowTrimRevision}
        conversationViewEnabledOverride={false}
        conversationViewStateKey="session-exploration"
        messages={messagesFor(tools)}
      />
    );

    const { rerender } = render(view([read, grep]));
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse explored tools" }),
    );

    rerender(view([read, grep, list]));
    expect(
      screen.getByRole("button", { name: "Expand explored tools" }),
    ).toBeTruthy();

    rerender(view([grep, list], 1));
    expect(
      screen.getByRole("button", { name: "Collapse explored tools" }),
    ).toBeTruthy();

    rerender(view([read, grep, list], 1));
    expect(
      screen.getByRole("button", { name: "Collapse explored tools" }),
    ).toBeTruthy();
  });

  it("shows compact conversation activity durations", () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "true");
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-short", "short turn", "2026-07-28T07:00:00.000Z"),
          codexThinkingMessage(
            "thinking-short-1",
            "starting",
            "2026-07-28T07:00:01.000Z",
          ),
          codexThinkingMessage(
            "thinking-short-2",
            "finishing",
            "2026-07-28T07:00:09.000Z",
          ),
          assistantMessage(
            "assistant-short",
            "Short answer",
            "2026-07-28T07:00:09.400Z",
          ),
          userMessage("user-long", "long turn", "2026-07-28T07:00:20.000Z"),
          codexThinkingMessage(
            "thinking-long-1",
            "starting",
            "2026-07-28T07:00:21.000Z",
          ),
          codexThinkingMessage(
            "thinking-long-2",
            "finishing",
            "2026-07-28T07:00:33.000Z",
          ),
          assistantMessage(
            "assistant-long",
            "Long answer",
            "2026-07-28T07:00:33.400Z",
          ),
        ]}
      />,
    );

    const labels = Array.from(
      container.querySelectorAll(".conversation-activity-summary"),
      (summary) => summary.textContent,
    );
    expect(labels).toEqual([
      expect.stringContaining("8.4s · 2 activities hidden"),
      expect.stringContaining("12s · 2 activities hidden"),
    ]);
  });

  it("keeps preview collapse and dismiss state by slot until thinking is retoggled", () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "true");
    const messages = (currentThinking: string) => [
      userMessage("user-1", "inspect this"),
      codexThinkingMessage("thinking-previous", "Previous plan"),
      assistantToolUseMessage("assistant-edit", [
        {
          type: "tool_use",
          id: "edit-1",
          name: "Edit",
          input: {
            file_path: "/repo/src/app.ts",
            old_string: "before",
            new_string: "after",
          },
        },
      ]),
      codexThinkingMessage(
        "thinking-current",
        currentThinking,
        undefined,
        true,
      ),
      assistantToolUseMessage("assistant-run", [
        {
          type: "tool_use",
          id: "run-1",
          name: "Bash",
          input: { command: "pnpm test" },
        },
      ]),
    ];
    const { container, rerender } = render(
      <MessageList isProcessing messages={messages("Current plan")} />,
    );

    expect(screen.getByText("Run")).toBeTruthy();
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(
      screen.getByText("Run").closest("li")?.getAttribute("data-tooltip"),
    ).toBe("Run: pnpm test");

    for (const collapse of screen.getAllByRole("button", {
      name: "Collapse thinking preview",
    })) {
      fireEvent.click(collapse);
    }
    expect(screen.queryByText("Run")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();

    rerender(
      <MessageList isProcessing messages={messages("Updated current plan")} />,
    );

    expect(screen.queryByText("Updated current plan")).toBeNull();
    expect(
      container.querySelectorAll(
        ".conversation-thinking-preview-toggle[aria-expanded='false']",
      ),
    ).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss Current thinking" }),
    );
    expect(screen.getByText("Previous thinking")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss Previous thinking" }),
    );
    expect(
      container.querySelector(".conversation-thinking-preview"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Show hidden thinking transcript rows/,
      }),
    );
    expect(
      container.querySelectorAll(
        ".conversation-thinking-preview-toggle[aria-expanded='true']",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("Updated current plan")).toBeTruthy();
  });

  it("bounds history to 100 turns on explicit Conversation activation", async () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "false");
    const messages = Array.from({ length: 105 }, (_, index) => [
      userMessage(`user-${index + 1}`, `request ${index + 1}`),
      assistantMessage(`assistant-${index + 1}`, `response ${index + 1}`),
    ]).flat();

    const { rerender } = render(
      <MessageList
        messages={messages}
        conversationViewStateKey="session-window"
      />,
    );

    rerender(
      <MessageList
        messages={messages}
        conversationViewStateKey="session-window"
        scrollToTurnRequest={{ id: "user-1", token: 1 }}
      />,
    );
    expect(await screen.findByText("request 1")).toBeTruthy();

    act(() => {
      setConversationViewPreference(true);
    });

    expect(screen.queryByText("request 1")).toBeNull();
    expect(screen.getByText("request 6")).toBeTruthy();
    expect(screen.getByText("Latest 100 user turns shown")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Load 5 earlier user turns" }),
    );

    rerender(
      <MessageList
        messages={messages}
        conversationViewStateKey="session-window"
        scrollToTurnRequest={{ id: "user-1", token: 2 }}
      />,
    );
    expect(await screen.findByText("request 1")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /earlier user turns/ }),
    ).toBeNull();
  });

  it("does not bound history when Conversation view is already active on load", async () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "true");
    const messages = Array.from({ length: 105 }, (_, index) => [
      userMessage(`user-${index + 1}`, `request ${index + 1}`),
      assistantMessage(`assistant-${index + 1}`, `response ${index + 1}`),
    ]).flat();

    const { rerender } = render(
      <MessageList
        messages={messages}
        conversationViewStateKey="session-default-window"
      />,
    );

    rerender(
      <MessageList
        messages={messages}
        conversationViewStateKey="session-default-window"
        scrollToTurnRequest={{ id: "user-1", token: 1 }}
      />,
    );
    expect(await screen.findByText("request 1")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /earlier user turns/ }),
    ).toBeNull();
  });

  it("uses the shared Conversation projection when an independent shell overrides the device default", () => {
    render(
      <MessageList
        conversationViewEnabledOverride
        messages={[
          userMessage("user-1", "inspect this"),
          codexThinkingMessage("thinking-1", "private planning"),
          assistantMessage("assistant-1", "Visible answer"),
        ]}
      />,
    );

    expect(screen.getByText("Visible answer")).toBeTruthy();
    expect(screen.queryByText("private planning")).toBeNull();
    expect(
      document.querySelector(".conversation-activity-summary"),
    ).toBeTruthy();
  });

  it("offers correction only for the latest real user message", () => {
    const onCorrect = vi.fn();

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first request"),
          assistantMessage("assistant-1", "response"),
          userMessage("user-2", "second request"),
        ]}
        onCorrectLatestUserMessage={onCorrect}
      />,
    );

    const buttons = screen.getAllByRole("button", {
      name: "Edit latest message",
    });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0] as HTMLElement);

    expect(onCorrect).toHaveBeenCalledWith("user-2", "second request");
  });

  it("shows a content-filter block with its guidance always visible", () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            type: "system",
            uuid: "msg-filter",
            subtype: "content_filter_block",
            content: "Offer a permitted alternative.",
          },
        ]}
      />,
    );

    // The shared MessageList i18n mock renders unlisted keys verbatim.
    expect(screen.getByText("contentFilterBlockTitle")).toBeTruthy();
    expect(screen.getByText(/Offer a permitted alternative\./)).toBeTruthy();
    expect(container.querySelector("details")).toBeNull();
  });

  it("renders compact summaries as one collapsed compact notification", () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            type: "system",
            uuid: "compact-boundary",
            subtype: "compact_boundary",
            content: "Conversation compacted",
            compactMetadata: { trigger: "manual", preTokens: 123 },
          },
          {
            type: "user",
            uuid: "compact-summary",
            message: {
              role: "user",
              content:
                "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- hidden detail",
            },
            isCompactSummary: true,
            isVisibleInTranscriptOnly: true,
          },
          {
            type: "user",
            uuid: "compact-stdout",
            message: {
              role: "user",
              content:
                "<local-command-stdout>Compacted </local-command-stdout>",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Conversation compacted")).toBeTruthy();
    expect(screen.queryByText("/compact")).toBeNull();
    expect(screen.queryByText("Compacted")).toBeNull();

    const compactDetails = container.querySelector(
      "details.system-message-compact-boundary",
    ) as HTMLDetailsElement | null;
    expect(compactDetails).toBeTruthy();
    expect(compactDetails?.open).toBe(false);

    const summary = compactDetails?.querySelector("summary");
    expect(summary).toBeTruthy();
    fireEvent.click(summary as HTMLElement);
    expect(compactDetails?.open).toBe(true);
    expect(screen.getByText(/hidden detail/)).toBeTruthy();
  });

  it("keeps bare compact boundaries outline-expandable without a summary body", () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            type: "system",
            uuid: "compact-bare",
            subtype: "compact_boundary",
            content: "Context compacted",
          },
        ]}
      />,
    );

    const compactDetails = container.querySelector(
      "details.system-message-compact-boundary",
    ) as HTMLDetailsElement | null;
    expect(compactDetails).toBeTruthy();
    expect(compactDetails?.open).toBe(false);
    fireEvent.click(compactDetails!.querySelector("summary") as HTMLElement);
    expect(compactDetails?.open).toBe(true);
    expect(
      screen.getByText("No provider summary was retained for this compaction."),
    ).toBeTruthy();
  });

  it("does not restart progressive loading after the session is revealed", async () => {
    vi.useFakeTimers();
    const messages = [
      userMessage("user-1", "first request"),
      assistantMessage("assistant-1", "first response"),
    ];
    const composerDraftSignal = createComposerDraftSignal();
    const { container, rerender } = render(
      <MessageList
        messages={messages}
        composerDraftSignal={composerDraftSignal}
        progressiveRenderEnabled
        progressiveRenderKey="session-1"
      />,
    );

    expect(container.querySelector(".session-render-progress")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(container.querySelector(".session-render-progress")).toBeNull();

    await act(async () => {
      composerDraftSignal.publishDraftChange("typing should stay local", {
        mayAffectQuoteAnchors: false,
      });
    });

    expect(container.querySelector(".session-render-progress")).toBeNull();

    await act(async () => {
      rerender(
        <MessageList
          messages={[...messages, userMessage("user-2", "second request")]}
          composerDraftSignal={composerDraftSignal}
          progressiveRenderEnabled
          progressiveRenderKey="session-1"
        />,
      );
    });

    expect(container.querySelector(".session-render-progress")).toBeNull();

    await act(async () => {
      rerender(
        <MessageList
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="session-2"
        />,
      );
    });

    expect(container.querySelector(".session-render-progress")).not.toBeNull();
  });

  it("pauses progressive rendering while the transcript is inert", async () => {
    vi.useFakeTimers();
    const messages = Array.from({ length: 160 }, (_, index) => [
      userMessage(`user-${index}`, `request ${index}`),
      assistantMessage(`assistant-${index}`, `response ${index}`),
    ]).flat();
    const { container, rerender } = render(
      <MessageList
        inert
        messages={messages}
        progressiveRenderEnabled
        progressiveRenderKey="parked-session"
      />,
    );
    const parkedRenderWeight = transcriptRenderWeight(container);

    expect(parkedRenderWeight).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(transcriptRenderWeight(container)).toBe(parkedRenderWeight);

    await act(async () => {
      rerender(
        <MessageList
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="parked-session"
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(1_501);
    });
    const resumedRenderWeight = transcriptRenderWeight(container);
    expect(resumedRenderWeight).toBeGreaterThan(parkedRenderWeight);

    await act(async () => {
      rerender(
        <MessageList
          inert
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="parked-session"
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(transcriptRenderWeight(container)).toBe(resumedRenderWeight);
  });

  it("compacts a completed transcript while parked and resumes without a loader", async () => {
    vi.useFakeTimers();
    const messages = Array.from({ length: 160 }, (_, index) => [
      userMessage(`user-${index}`, `request ${index}`),
      assistantMessage(`assistant-${index}`, `response ${index}`),
    ]).flat();
    const pauseSignal = { current: false, supportsCompaction: false };
    const { container, rerender } = render(
      <MessageList
        messages={messages}
        progressiveRenderEnabled
        progressiveRenderKey="retained-session"
        progressiveRenderPauseSignal={pauseSignal}
      />,
    );
    for (let batch = 0; batch < 40; batch += 1) {
      await act(async () => {
        vi.advanceTimersByTime(33);
      });
    }
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    const completedRenderWeight = transcriptRenderWeight(container);
    expect(container.querySelector(".session-render-progress")).toBeNull();
    expect(pauseSignal.supportsCompaction).toBe(true);

    pauseSignal.current = true;
    await act(async () => {
      rerender(
        <MessageList
          inert
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="retained-session"
          progressiveRenderPauseSignal={pauseSignal}
        />,
      );
    });
    const parkedRenderWeight = transcriptRenderWeight(container);
    expect(parkedRenderWeight).toBeLessThan(completedRenderWeight);

    pauseSignal.current = false;
    await act(async () => {
      rerender(
        <MessageList
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="retained-session"
          progressiveRenderPauseSignal={pauseSignal}
        />,
      );
    });
    expect(container.querySelector(".session-render-progress")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1_499);
    });
    expect(transcriptRenderWeight(container)).toBe(parkedRenderWeight);
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(transcriptRenderWeight(container)).toBeGreaterThan(
      parkedRenderWeight,
    );
    expect(transcriptRenderWeight(container)).toBeLessThan(
      completedRenderWeight,
    );
  });

  it("can hide progressive details while hydrating", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first request"),
          assistantMessage("assistant-1", "first response"),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="session-1"
        progressiveRenderStatusVisible={false}
      />,
    );

    expect(container.querySelector(".session-render-progress")).not.toBeNull();
    expect(screen.getByText("Loading session...")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Rendering transcript/)).toBeNull();
  });

  it("does not publish scroll snapshots while progressively hydrating", () => {
    vi.useFakeTimers();
    const onScrollSnapshotChange = vi.fn();
    const { container, unmount } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first request"),
          assistantMessage("assistant-1", "first response"),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="snapshot-gate-active"
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

    fireEvent.scroll(container);
    expect(onScrollSnapshotChange).not.toHaveBeenCalled();

    unmount();
    expect(onScrollSnapshotChange).not.toHaveBeenCalled();
  });

  it("publishes a settled scroll snapshot after progressive hydration", async () => {
    vi.useFakeTimers();
    const onScrollSnapshotChange = vi.fn();
    const assistantTimestamp = "2026-04-26T12:01:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "first response", assistantTimestamp),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="snapshot-gate-complete"
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
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(40, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(420, 80);

    expect(onScrollSnapshotChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(onScrollSnapshotChange).toHaveBeenCalledTimes(1);
    expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        atBottom: true,
        scrollTop: 700,
        anchor: expect.objectContaining({
          id: "user-1",
          topOffset: 40,
          nextId: "assistant-1",
          timestampMs: new Date("2026-04-26T12:00:00.000Z").getTime(),
        }),
      }),
    );
  });

  it("renders slash-command skill text as collapsed command details", () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            type: "user",
            uuid: "command",
            promptId: "prompt-1",
            message: {
              role: "user",
              content:
                "<command-message>harsh-review</command-message>\n" +
                "<command-name>/harsh-review</command-name>\n" +
                "<command-args>last 10 commits</command-args>",
            },
          },
          {
            type: "user",
            uuid: "skill-body",
            isMeta: true,
            parentUuid: "command",
            promptId: "prompt-1",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Base directory for this skill: /home/graehl/.claude/skills/harsh-review\n\n" +
                    "# Harsh review\n\nFirst classify each changed artifact.",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("/harsh-review last 10 commits")).toBeTruthy();
    expect(
      container.querySelector("[data-render-type='user_prompt']"),
    ).toBeNull();

    const commandDetails = container.querySelector(
      "details.system-message-local-command",
    ) as HTMLDetailsElement | null;
    expect(commandDetails).toBeTruthy();
    expect(commandDetails?.open).toBe(false);

    const summary = commandDetails?.querySelector("summary");
    expect(summary).toBeTruthy();
    fireEvent.click(summary as HTMLElement);
    expect(commandDetails?.open).toBe(true);
    expect(
      screen.getByText(/First classify each changed artifact/),
    ).toBeTruthy();
  });

  it("shows an error notice's details without a click", () => {
    const notice = (id: string, detailsOpen?: boolean) => ({
      type: "system",
      subtype: "local_command",
      uuid: id,
      id,
      session_id: "session-1",
      timestamp: "2026-09-26T04:00:00.000Z",
      isSynthetic: true,
      content: `notice ${id}`,
      details: [`reason ${id}`],
      ...(detailsOpen ? { detailsOpen } : {}),
    });
    const { container } = render(
      <MessageList
        messages={
          [notice("error", true), notice("plain")] as unknown as Parameters<
            typeof MessageList
          >[0]["messages"]
        }
      />,
    );

    const rows = Array.from(
      container.querySelectorAll("details.system-message-local-command"),
    ) as HTMLDetailsElement[];
    expect(rows.map((row) => row.open)).toEqual([true, false]);
    expect(rows[0]?.textContent).toContain("reason error");
  });

  it("passes display text without uploaded-file metadata to correction", () => {
    const onCorrect = vi.fn();

    render(
      <MessageList
        messages={[
          userMessage(
            "user-1",
            "fix typo\n\nUser uploaded files:\n- notes.txt (12 B, text/plain): /uploads/notes.txt",
          ),
        ]}
        onCorrectLatestUserMessage={onCorrect}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit latest message" }),
    );

    expect(onCorrect).toHaveBeenCalledWith("user-1", "fix typo");
  });

  it("renders correction messages with corrected text as the primary content", () => {
    render(
      <MessageList
        messages={[
          userMessage(
            "user-1",
            buildCorrectionText("(testing)", "(test correction)") ?? "",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Correction")).toBeTruthy();
    expect(screen.getByText("(test correction)")).toBeTruthy();
    expect(
      screen.getByText('Change: replace "testing" with "test correction".'),
    ).toBeTruthy();
  });
});
