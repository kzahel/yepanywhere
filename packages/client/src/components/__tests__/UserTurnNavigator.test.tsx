// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserTurnNavigator } from "../UserTurnNavigator";
import styles from "../UserTurnNavigator.module.css";

/** CSS Module keys are typed optional; a missing one is a broken contract. */
function cls(name: string | undefined): string {
  if (!name) throw new Error("UserTurnNavigator.module.css class missing");
  return name;
}

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        turnNotchJump: "Jump",
        turnNotchForkBefore: "Fork before…",
        turnNotchForkAfter: "Fork after…",
        turnNotchCopy: "Copy",
        turnNotchShowFrom: "Show from",
        turnNotchHandoffFrom: "Handoff from…",
        sourceMoreActions: "More actions",
        turnNotchJumpToTurn: "Jump to turn",
        turnNotchShowFromTurn: "Load client transcript from turn",
      })[key] ?? key,
  }),
}));

function rect({
  top,
  height,
  right = 500,
  width = 400,
}: {
  top: number;
  height: number;
  right?: number;
  width?: number;
}): DOMRect {
  return {
    x: right - width,
    y: top,
    top,
    right,
    bottom: top + height,
    left: right - width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setReadonlyNumber(
  element: HTMLElement,
  key: "clientHeight" | "clientWidth" | "offsetWidth" | "scrollHeight",
  value: number,
) {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
  });
}

function dispatchPointerMove(
  element: HTMLElement,
  clientX: number,
  clientY: number,
) {
  const event = new Event("pointermove", { bubbles: true });
  Object.defineProperty(event, "clientX", {
    configurable: true,
    value: clientX,
  });
  Object.defineProperty(event, "clientY", {
    configurable: true,
    value: clientY,
  });
  element.dispatchEvent(event);
}

function dispatchElementPointerMove(element: HTMLElement, clientY: number) {
  element.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientY,
    }),
  );
}

describe("UserTurnNavigator", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows user turn previews and scrolls to the selected turn", async () => {
    let scrollTop = 0;
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const firstRow = document.createElement("div");
    const secondRow = document.createElement("div");
    const onPreviewTimestampChange = vi.fn();
    const scrollTo = vi.fn(
      (optionsOrX?: ScrollToOptions | number, y?: number) => {
        scrollTop =
          typeof optionsOrX === "number"
            ? optionsOrX
            : Number(optionsOrX?.top ?? y ?? 0);
        scrollContainer.dispatchEvent(new Event("scroll"));
      },
    );

    firstRow.dataset.renderId = "user-1";
    secondRow.dataset.renderId = "user-2";
    messageList.append(firstRow, secondRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      },
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    firstRow.getBoundingClientRect = () =>
      rect({ top: 100 + 20 - scrollTop, height: 30 });
    secondRow.getBoundingClientRect = () =>
      rect({ top: 100 + 620 - scrollTop, height: 30 });
    scrollContainer.scrollTo = scrollTo as typeof scrollContainer.scrollTo;

    render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "First request", timestampMs: 1000 },
          {
            id: "user-2",
            preview: "Second request with more context",
            timestampMs: 2000,
          },
        ]}
        messageListRef={{ current: messageList }}
        onPreviewTimestampChange={onPreviewTimestampChange}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Jump to turn: Second request with more context",
      }),
    ).toBeNull();

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });

    const secondMarker = await screen.findByRole("button", {
      name: "Jump to turn: Second request with more context",
    });
    expect(
      document.querySelector<HTMLElement>("[data-turn-rail]")?.style.right,
    ).toBe(`${window.innerWidth - 500 + (380 - 360)}px`);

    fireEvent.pointerEnter(secondMarker);
    expect(screen.getByText("Second request with more context")).toBeTruthy();
    expect(onPreviewTimestampChange).toHaveBeenLastCalledWith(2000);
    expect(
      document
        .querySelector(`.${cls(styles.preview)}`)
        ?.classList.contains(cls(styles.short)),
    ).toBe(true);

    fireEvent.click(secondMarker);
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({
        top: 608,
        behavior: "auto",
      });
    });
    expect(
      document.querySelector(
        `.${cls(styles.motionCue)}.${cls(styles.motionDown)}`,
      ),
    ).toBeTruthy();
  });

  it("lays out and wakes a turn outside the mounted render window", async () => {
    let scrollTop = 0;
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const mountedRow = document.createElement("div");
    const revealRenderId = vi.fn(() => true);
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scrollTop = Number(options.top ?? 0);
    });

    mountedRow.dataset.renderId = "user-2";
    messageList.append(mountedRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      },
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    mountedRow.getBoundingClientRect = () =>
      rect({ top: 720 - scrollTop, height: 30 });
    scrollContainer.scrollTo = scrollTo as typeof scrollContainer.scrollTo;

    render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "Windowed request" },
          { id: "user-2", preview: "Mounted request" },
        ]}
        messageListRef={{ current: messageList }}
        getRenderIdTop={(id) => (id === "user-1" ? 120 : null)}
        revealRenderId={revealRenderId}
      />,
    );

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Jump to turn: Windowed request",
      }),
    );

    expect(revealRenderId).toHaveBeenCalledWith("user-1");
    expect(scrollTo).toHaveBeenCalledWith({ top: 108, behavior: "auto" });
  });

  it("opens compact turn context actions for fork before and after", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const firstRow = document.createElement("div");
    const secondRow = document.createElement("div");
    const onForkBeforeAnchor = vi.fn();
    const onForkAfterAnchor = vi.fn();
    const onCopyAnchor = vi.fn();
    const onTrimAnchor = vi.fn();
    const onHandoffFromAnchor = vi.fn();

    firstRow.dataset.renderId = "user-1";
    secondRow.dataset.renderId = "user-2";
    messageList.append(firstRow, secondRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    firstRow.getBoundingClientRect = () => rect({ top: 120, height: 30 });
    secondRow.getBoundingClientRect = () => rect({ top: 520, height: 30 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "First request" },
          { id: "user-2", preview: "Second request" },
        ]}
        messageListRef={{ current: messageList }}
        onForkBeforeAnchor={onForkBeforeAnchor}
        onForkAfterAnchor={onForkAfterAnchor}
        onCopyAnchor={onCopyAnchor}
        onTrimAnchor={onTrimAnchor}
        onHandoffFromAnchor={onHandoffFromAnchor}
      />,
    );

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });

    const marker = await screen.findByRole("button", {
      name: "Jump to turn: First request",
    });
    fireEvent.contextMenu(marker, { clientX: 492, clientY: 150 });

    expect(screen.getByRole("menu", { name: "More actions" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Jump" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Fork before…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Fork after…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Show from" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Handoff from…" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Fork after…" }));

    expect(onForkAfterAnchor).toHaveBeenCalledWith("user-1");
    expect(onForkBeforeAnchor).not.toHaveBeenCalled();
    expect(onCopyAnchor).not.toHaveBeenCalled();
    expect(onTrimAnchor).not.toHaveBeenCalled();
    expect(onHandoffFromAnchor).not.toHaveBeenCalled();
  });

  it("hands off from a turn in-tab on click and in a new tab on middle click", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const firstRow = document.createElement("div");
    const secondRow = document.createElement("div");
    const onHandoffFromAnchor = vi.fn();

    firstRow.dataset.renderId = "user-1";
    secondRow.dataset.renderId = "user-2";
    messageList.append(firstRow, secondRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    firstRow.getBoundingClientRect = () => rect({ top: 120, height: 30 });
    secondRow.getBoundingClientRect = () => rect({ top: 520, height: 30 });

    render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "First request" },
          { id: "user-2", preview: "Second request" },
        ]}
        messageListRef={{ current: messageList }}
        onHandoffFromAnchor={onHandoffFromAnchor}
      />,
    );

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });
    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Jump to turn: First request",
      }),
      { clientX: 492, clientY: 150 },
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Handoff from…" }));
    expect(onHandoffFromAnchor).toHaveBeenCalledWith("user-1", {
      newTab: false,
    });

    fireEvent.contextMenu(
      await screen.findByRole("button", {
        name: "Jump to turn: First request",
      }),
      { clientX: 492, clientY: 150 },
    );
    fireEvent(
      screen.getByRole("menuitem", { name: "Handoff from…" }),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onHandoffFromAnchor).toHaveBeenLastCalledWith("user-1", {
      newTab: true,
    });
  });

  it("reconciles removed bookmarks, previews, menus, and rail geometry", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "user-2", "user-3"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });
    const onPreviewTimestampChange = vi.fn();
    let scrollHeight = 1000;
    let anchors = [
      { id: "user-1", preview: "Removed request", timestampMs: 1000 },
      { id: "user-2", preview: "Middle request", timestampMs: 2000 },
      { id: "user-3", preview: "Latest request", timestampMs: 3000 },
    ];

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        rect({ top: 120 + index * 300, height: 30 });
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const rendered = render(
      <UserTurnNavigator
        anchors={anchors}
        messageListRef={{ current: messageList }}
        onForkBeforeAnchor={vi.fn()}
        onPreviewTimestampChange={onPreviewTimestampChange}
      />,
    );

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });
    const removedMarker = await screen.findByRole("button", {
      name: "Jump to turn: Removed request",
    });
    fireEvent.pointerEnter(removedMarker);
    expect(screen.getByText("Removed request")).toBeTruthy();
    expect(onPreviewTimestampChange).toHaveBeenLastCalledWith(1000);
    expect(
      document.querySelector<HTMLElement>(`.${cls(styles.thumb)}`)?.style
        .height,
    ).toBe("20%");

    rows[0]?.remove();
    scrollHeight = 500;
    anchors = anchors.slice(1);
    rendered.rerender(
      <UserTurnNavigator
        anchors={anchors}
        messageListRef={{ current: messageList }}
        onForkBeforeAnchor={vi.fn()}
        onPreviewTimestampChange={onPreviewTimestampChange}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: "Jump to turn: Removed request",
        }),
      ).toBeNull();
      expect(screen.queryByText("Removed request")).toBeNull();
      expect(onPreviewTimestampChange).toHaveBeenLastCalledWith(null);
      expect(
        document.querySelector<HTMLElement>(`.${cls(styles.thumb)}`)?.style
          .height,
      ).toBe("40%");
    });

    const middleMarker = screen.getByRole("button", {
      name: "Jump to turn: Middle request",
    });
    fireEvent.contextMenu(middleMarker, { clientX: 492, clientY: 150 });
    expect(screen.getByRole("menuitem", { name: "Jump" })).toBeTruthy();

    rows[1]?.remove();
    anchors = anchors.slice(1);
    rendered.rerender(
      <UserTurnNavigator
        anchors={anchors}
        messageListRef={{ current: messageList }}
        onForkBeforeAnchor={vi.fn()}
        onPreviewTimestampChange={onPreviewTimestampChange}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Jump" })).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "Jump to turn: Middle request",
        }),
      ).toBeNull();
    });
  });

  it("does not jump after a long press opens turn actions", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const firstRow = document.createElement("div");
    const secondRow = document.createElement("div");

    firstRow.dataset.renderId = "user-1";
    secondRow.dataset.renderId = "user-2";
    messageList.append(firstRow, secondRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    firstRow.getBoundingClientRect = () => rect({ top: 120, height: 30 });
    secondRow.getBoundingClientRect = () => rect({ top: 520, height: 30 });
    const scrollTo = vi.fn();
    scrollContainer.scrollTo = scrollTo as typeof scrollContainer.scrollTo;

    render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "First request" },
          { id: "user-2", preview: "Second request" },
        ]}
        messageListRef={{ current: messageList }}
        onForkBeforeAnchor={vi.fn()}
      />,
    );

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });
    const marker = await screen.findByRole("button", {
      name: "Jump to turn: First request",
    });

    vi.useFakeTimers();
    fireEvent.touchStart(marker, {
      touches: [{ clientX: 492, clientY: 150 }],
    });
    act(() => {
      vi.advanceTimersByTime(450);
    });

    expect(screen.getByRole("menuitem", { name: "Jump" })).toBeTruthy();
    fireEvent.click(marker);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not build normal rail anchors until the scrollbar hotzone is active", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const firstRow = document.createElement("div");
    const secondRow = document.createElement("div");
    const getAnchors = vi.fn(() => [
      { id: "user-1", preview: "First request" },
      { id: "user-2", preview: "Second request" },
    ]);

    firstRow.dataset.renderId = "user-1";
    secondRow.dataset.renderId = "user-2";
    messageList.append(firstRow, secondRow);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    firstRow.getBoundingClientRect = () => rect({ top: 120, height: 30 });
    secondRow.getBoundingClientRect = () => rect({ top: 520, height: 30 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    render(
      <UserTurnNavigator
        getAnchors={getAnchors}
        messageListRef={{ current: messageList }}
      />,
    );

    expect(getAnchors).not.toHaveBeenCalled();

    act(() => {
      dispatchPointerMove(scrollContainer, 492, 150);
    });

    await waitFor(() => {
      expect(getAnchors).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByRole("button", {
        name: "Jump to turn: Second request",
      }),
    ).toBeTruthy();
  });

  it("shows compact previews for every matching search marker when crowded", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "assistant-1", "system-1"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 160);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 160 });
    rows[0]!.getBoundingClientRect = () => rect({ top: 120, height: 24 });
    rows[1]!.getBoundingClientRect = () => rect({ top: 180, height: 24 });
    rows[2]!.getBoundingClientRect = () => rect({ top: 240, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "User request" },
          { id: "assistant-1", preview: "Assistant response" },
          { id: "system-1", preview: "System note" },
        ]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "assistant-1",
          matchIds: new Set(["user-1", "assistant-1", "system-1"]),
          preview: "assistant match snippet",
          query: "match",
          previewsById: new Map([
            ["user-1", "user match snippet"],
            ["assistant-1", "assistant match snippet"],
            ["system-1", "system match snippet"],
          ]),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(`.${cls(styles.preview)}`),
      ).toHaveLength(3);
    });
    const previews = Array.from(
      container.querySelectorAll(`.${cls(styles.preview)}`),
    );
    expect(previews.map((preview) => preview.textContent)).toEqual([
      "user match snippet",
      "assistant match snippet",
      "system match snippet",
    ]);
    expect(
      container.querySelectorAll(`.${cls(styles.previewMatch)}`),
    ).toHaveLength(3);
    expect(
      previews.every((preview) =>
        preview?.classList.contains(cls(styles.compact)),
      ),
    ).toBe(true);
    expect(
      previews.some((preview) =>
        preview.classList.contains(cls(styles.expanded)),
      ),
    ).toBe(false);
  });

  it("pulses the preview for one remaining search match", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const row = document.createElement("div");

    row.dataset.renderId = "user-1";
    messageList.append(row);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    row.getBoundingClientRect = () => rect({ top: 180, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[{ id: "user-1", preview: "Only matching request" }]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "user-1",
          matchIds: new Set(["user-1"]),
          preview: "Only matching request",
          query: "only",
          previewsById: new Map([["user-1", "Only matching request"]]),
        }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(`.${cls(styles.preview)}`)).toBeTruthy();
    });
    const preview = container.querySelector(`.${cls(styles.preview)}`);
    expect(preview?.classList.contains(cls(styles.singleSearchMatch))).toBe(
      true,
    );
    expect(preview?.classList.contains(cls(styles.expanded))).toBe(false);
    expect(preview?.textContent).toBe("Only matching request");
  });

  it("anchors a top-edge active search preview inside the rail", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const row = document.createElement("div");

    row.dataset.renderId = "user-1";
    messageList.append(row);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 160);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 160 });
    row.getBoundingClientRect = () => rect({ top: 100, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[{ id: "user-1", preview: "first visible match" }]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "user-1",
          matchIds: new Set(["user-1"]),
          preview: "first visible match",
          query: "visible",
          previewsById: new Map([["user-1", "first visible match"]]),
        }}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(`.${cls(styles.preview)}`)).toBeTruthy();
    });
    const preview = container.querySelector<HTMLElement>(
      `.${cls(styles.preview)}`,
    );
    expect(preview?.classList.contains(cls(styles.expanded))).toBe(false);
    expect(preview?.style.top).toBe("1px");
    expect(
      preview?.style.getPropertyValue("--user-turn-nav-preview-translate-y"),
    ).toBe("0");
  });

  it("keeps search preview targets fixed while hovering across them", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "assistant-1", "system-1"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });
    const onSearchMatchSelect = vi.fn();

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 360);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 360 });
    rows[0]!.getBoundingClientRect = () => rect({ top: 120, height: 24 });
    rows[1]!.getBoundingClientRect = () => rect({ top: 280, height: 24 });
    rows[2]!.getBoundingClientRect = () => rect({ top: 440, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const anchors = [
      { id: "user-1", preview: "user match snippet" },
      { id: "assistant-1", preview: "assistant match snippet" },
      { id: "system-1", preview: "system match snippet" },
    ];
    const matchIds = new Set(["user-1", "assistant-1", "system-1"]);
    const previewsById = new Map([
      ["user-1", "user match snippet"],
      ["assistant-1", "assistant match snippet"],
      ["system-1", "system match snippet"],
    ]);
    const renderNavigator = (activeId: string, preview: string) => (
      <UserTurnNavigator
        anchors={anchors}
        messageListRef={{ current: messageList }}
        onSearchMatchSelect={onSearchMatchSelect}
        searchState={{
          activeId,
          matchIds,
          preview,
          query: "match",
          previewsById,
        }}
      />
    );

    const { container, rerender } = render(
      renderNavigator("assistant-1", "assistant match snippet"),
    );

    const userPreview = await screen.findByRole("button", {
      name: "user match snippet",
    });
    const getPreviewTops = () =>
      new Map(
        Array.from(
          container.querySelectorAll<HTMLElement>(`.${cls(styles.preview)}`),
          (preview) => [
            preview.getAttribute("aria-label") ?? "",
            preview.style.top,
          ],
        ),
      );
    const initialTops = getPreviewTops();
    expect(userPreview.classList.contains(cls(styles.expanded))).toBe(false);

    fireEvent.pointerEnter(userPreview);

    await waitFor(() => {
      expect(userPreview.classList.contains(cls(styles.expanded))).toBe(true);
    });
    expect(userPreview.classList.contains(cls(styles.pinnedExpanded))).toBe(
      true,
    );
    expect(getPreviewTops()).toEqual(initialTops);

    const assistantPreview = container.querySelector<HTMLElement>(
      '[aria-label="assistant match snippet"]',
    );
    expect(assistantPreview).toBeTruthy();
    fireEvent.pointerEnter(assistantPreview!);

    await waitFor(() => {
      expect(assistantPreview?.classList.contains(cls(styles.expanded))).toBe(
        true,
      );
    });
    expect(getPreviewTops()).toEqual(initialTops);

    expect(onSearchMatchSelect).not.toHaveBeenCalled();
    expect(scrollContainer.scrollTo).not.toHaveBeenCalled();

    rerender(renderNavigator("system-1", "system match snippet"));

    await waitFor(() => {
      expect(userPreview.classList.contains(cls(styles.expanded))).toBe(false);
      expect(
        Array.from(
          container.querySelectorAll(`.${cls(styles.preview)}`),
          (preview) => preview.classList.contains(cls(styles.expanded)),
        ),
      ).toEqual([false, false, false]);
    });
  });

  it("focuses collapsed search previews around the needle", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "assistant-1"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 180);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 180 });
    rows[0]!.getBoundingClientRect = () => rect({ top: 120, height: 24 });
    rows[1]!.getBoundingClientRect = () => rect({ top: 210, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const longPreview = `${"leading context ".repeat(
      12,
    )}needle should appear in the collapsed first line with useful right context`;

    const { container } = render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: longPreview },
          { id: "assistant-1", preview: "active needle snippet" },
        ]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "assistant-1",
          matchIds: new Set(["user-1", "assistant-1"]),
          preview: "active needle snippet",
          query: "needle",
          previewsById: new Map([
            ["user-1", longPreview],
            ["assistant-1", "active needle snippet"],
          ]),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(`.${cls(styles.preview)}`),
      ).toHaveLength(2);
    });
    const collapsed = container.querySelector<HTMLElement>(
      '[aria-label^="leading context"]',
    );
    expect(collapsed?.classList.contains(cls(styles.expanded))).toBe(false);
    expect(collapsed?.textContent).toContain("needle should appear");
    expect(collapsed?.textContent?.startsWith("leading context")).toBe(false);
    expect(collapsed?.textContent?.startsWith("...")).toBe(true);
  });

  it("keeps crowded expanded previews in vertical order when focus moves", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "assistant-1", "system-1"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 220);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 220 });
    rows[0]!.getBoundingClientRect = () => rect({ top: 110, height: 24 });
    rows[1]!.getBoundingClientRect = () => rect({ top: 118, height: 24 });
    rows[2]!.getBoundingClientRect = () => rect({ top: 126, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const anchors = [
      { id: "user-1", preview: "user match snippet" },
      { id: "assistant-1", preview: "assistant match snippet" },
      { id: "system-1", preview: "system match snippet" },
    ];
    const searchState = {
      matchIds: new Set(["user-1", "assistant-1", "system-1"]),
      query: "match",
      previewsById: new Map([
        ["user-1", "user match snippet"],
        ["assistant-1", "assistant match snippet"],
        ["system-1", "system match snippet"],
      ]),
    };
    const renderNavigator = (activeId: string, preview: string) => (
      <UserTurnNavigator
        anchors={anchors}
        messageListRef={{ current: messageList }}
        searchState={{
          ...searchState,
          activeId,
          preview,
        }}
      />
    );

    const { container } = render(
      renderNavigator("assistant-1", "assistant match snippet"),
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(`.${cls(styles.preview)}`),
      ).toHaveLength(3);
    });
    const initialTopValues = Array.from(
      container.querySelectorAll<HTMLElement>(`.${cls(styles.preview)}`),
      (preview) => Number.parseFloat(preview.style.top),
    );
    expect(initialTopValues.every(Number.isFinite)).toBe(true);
    expect(initialTopValues).toEqual(
      [...initialTopValues].sort((a, b) => a - b),
    );

    const userPreview = container.querySelector<HTMLElement>(
      '[aria-label="user match snippet"]',
    );
    fireEvent.pointerEnter(userPreview!);

    await waitFor(() => {
      expect(userPreview?.classList.contains(cls(styles.expanded))).toBe(true);
    });
    const topValues = Array.from(
      container.querySelectorAll<HTMLElement>(`.${cls(styles.preview)}`),
      (preview) => Number.parseFloat(preview.style.top),
    );
    expect(topValues.every(Number.isFinite)).toBe(true);
    expect(topValues).toEqual([...topValues].sort((a, b) => a - b));
  });

  it("routes search preview clicks through the search navigation owner", async () => {
    let scrollTop = 0;
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const row = document.createElement("div");
    const searchInput = document.createElement("input");
    const onSearchMatchSelect = vi.fn();
    const scrollTo = vi.fn(
      (optionsOrX?: ScrollToOptions | number, y?: number) => {
        scrollTop =
          typeof optionsOrX === "number"
            ? optionsOrX
            : Number(optionsOrX?.top ?? y ?? 0);
      },
    );

    row.dataset.renderId = "explored-row";
    messageList.append(row);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer, searchInput);
    searchInput.focus();

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      },
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    row.getBoundingClientRect = () =>
      rect({ top: 420 - scrollTop, height: 24 });
    scrollContainer.scrollTo = scrollTo as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[
          {
            id: "explored-row:grep-1",
            targetId: "explored-row",
            preview: "Explored / Grep: pattern: searchNeedle",
          },
        ]}
        messageListRef={{ current: messageList }}
        onSearchMatchSelect={onSearchMatchSelect}
        searchState={{
          activeId: "explored-row:grep-1",
          matchIds: new Set(["explored-row:grep-1"]),
          preview: "Explored / Grep: pattern: searchNeedle",
          query: "grep",
          previewsById: new Map([
            ["explored-row:grep-1", "Explored / Grep: pattern: searchNeedle"],
          ]),
        }}
      />,
    );

    const preview = await screen.findByRole("button", {
      name: "Explored / Grep: pattern: searchNeedle",
    });

    expect(preview.classList.contains(cls(styles.expanded))).toBe(false);
    fireEvent.pointerEnter(preview);
    await waitFor(() => {
      expect(preview.classList.contains(cls(styles.expanded))).toBe(true);
    });
    expect(
      Array.from(
        container.querySelectorAll(`.${cls(styles.facsimileTag)}`),
        (tag) => tag.textContent,
      ),
    ).toEqual(["Explored", "Grep"]);
    expect(
      container.querySelector(`.${cls(styles.facsimileLine)}`)?.textContent,
    ).toBe("pattern: searchNeedle");
    expect(
      container.querySelector(`.${cls(styles.preview)}`)?.textContent,
    ).toContain("pattern: searchNeedle");
    expect(
      container.querySelector(`.${cls(styles.preview)}`)?.textContent,
    ).not.toContain("Explored / Grep");
    expect(preview.classList.contains(cls(styles.expanded))).toBe(true);
    expect(
      container
        .querySelector(`.${cls(styles.preview)}`)
        ?.classList.contains(cls(styles.singleSearchMatch)),
    ).toBe(true);
    expect(fireEvent.mouseDown(preview)).toBe(false);
    expect(document.activeElement).toBe(searchInput);

    fireEvent.click(preview);

    expect(onSearchMatchSelect).toHaveBeenCalledWith(
      "explored-row:grep-1",
      "explored-row",
    );
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(searchInput);
    searchInput.remove();
  });

  it("formats escaped newlines inside expanded search previews", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const row = document.createElement("div");

    row.dataset.renderId = "explored-row";
    messageList.append(row);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 200);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 200 });
    row.getBoundingClientRect = () => rect({ top: 180, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const previewText =
      "Explored / Grep: grep searchNeedle\\npackages/client/src/components/UserTurnNavigator.tsx";
    const { container } = render(
      <UserTurnNavigator
        anchors={[
          {
            id: "explored-row:grep-1",
            targetId: "explored-row",
            preview: previewText,
          },
        ]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "explored-row:grep-1",
          matchIds: new Set(["explored-row:grep-1"]),
          preview: previewText,
          query: "grep",
          previewsById: new Map([["explored-row:grep-1", previewText]]),
        }}
      />,
    );

    const previewButton = await screen.findByRole("button", {
      name: previewText,
    });

    expect(previewButton.classList.contains(cls(styles.expanded))).toBe(false);
    fireEvent.pointerEnter(previewButton);
    await waitFor(() => {
      expect(previewButton.classList.contains(cls(styles.expanded))).toBe(true);
    });

    const preview = container.querySelector(`.${cls(styles.preview)}`);
    const lines = Array.from(
      container.querySelectorAll(`.${cls(styles.facsimileLine)}`),
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      "grep searchNeedle",
      "packages/client/src/components/UserTurnNavigator.tsx",
    ]);
    expect(
      container.querySelector(
        `.${cls(styles.facsimileLine)}.${cls(styles.mono)}`,
      )?.textContent,
    ).toBe("grep searchNeedle");
    expect(preview?.textContent).not.toContain("\\n");
  });

  it("keeps spaced search previews one-line until hover", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = ["user-1", "assistant-1", "system-1"].map((id) => {
      const row = document.createElement("div");
      row.dataset.renderId = id;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 1000);
    setReadonlyNumber(scrollContainer, "clientHeight", 600);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 600 });
    rows[0]!.getBoundingClientRect = () => rect({ top: 120, height: 24 });
    rows[1]!.getBoundingClientRect = () => rect({ top: 600, height: 24 });
    rows[2]!.getBoundingClientRect = () => rect({ top: 1000, height: 24 });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={[
          { id: "user-1", preview: "User request" },
          { id: "assistant-1", preview: "Assistant response" },
          { id: "system-1", preview: "System note" },
        ]}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "assistant-1",
          matchIds: new Set(["user-1", "assistant-1", "system-1"]),
          preview: "assistant match snippet with enough surrounding detail",
          query: "match",
          previewsById: new Map([
            ["user-1", "user match snippet with enough surrounding detail"],
            [
              "assistant-1",
              "assistant match snippet with enough surrounding detail",
            ],
            ["system-1", "system match snippet with enough surrounding detail"],
          ]),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(`.${cls(styles.preview)}`),
      ).toHaveLength(3);
    });
    const previews = Array.from(
      container.querySelectorAll(`.${cls(styles.preview)}`),
    );
    expect(
      previews.some((preview) =>
        preview.classList.contains(cls(styles.compact)),
      ),
    ).toBe(false);
    expect(
      previews.some((preview) => preview.classList.contains(cls(styles.short))),
    ).toBe(false);
    expect(
      previews.some((preview) =>
        preview.classList.contains(cls(styles.expanded)),
      ),
    ).toBe(false);

    const activePreview = container.querySelector<HTMLElement>(
      '[aria-label="assistant match snippet with enough surrounding detail"]',
    );
    fireEvent.pointerEnter(activePreview!);
    await waitFor(() => {
      expect(activePreview?.classList.contains(cls(styles.expanded))).toBe(
        true,
      );
    });
    expect(
      container.querySelector(`.${cls(styles.facsimileLine)}`)?.textContent,
    ).toBe("assistant match snippet with enough surrounding detail");
  });

  it("keeps search previews near the active match instead of rendering every match", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = Array.from({ length: 28 }, (_, index) => {
      const row = document.createElement("div");
      row.dataset.renderId = `match-${index + 1}`;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 2000);
    setReadonlyNumber(scrollContainer, "clientHeight", 240);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 240 });
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        rect({ top: 110 + index * 8, height: 20 });
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={rows.map((row, index) => ({
          id: row.dataset.renderId ?? "",
          preview: `match snippet ${index + 1}`,
        }))}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "match-26",
          matchIds: new Set(
            rows.map((row) => row.dataset.renderId).filter(Boolean) as string[],
          ),
          preview: "active match snippet",
          query: "match",
          previewsById: new Map(
            rows.map((row, index) => [
              row.dataset.renderId ?? "",
              `match snippet ${index + 1}`,
            ]),
          ),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(`.${cls(styles.preview)}`).length,
      ).toBeGreaterThan(1);
    });

    const previewTexts = Array.from(
      container.querySelectorAll(`.${cls(styles.preview)}`),
      (preview) => preview.textContent,
    );
    expect(previewTexts.length).toBeLessThan(rows.length);
    expect(previewTexts).not.toContain("match snippet 1");
    expect(previewTexts).toContain("match snippet 26");

    const topPreview = container.querySelector<HTMLElement>(
      `.${cls(styles.preview)}`,
    );
    expect(topPreview?.textContent).toBe("match snippet 15");
    const initialPreviewTexts = Array.from(
      container.querySelectorAll(`.${cls(styles.preview)}`),
      (preview) => preview.textContent,
    );
    fireEvent.pointerEnter(topPreview!);

    await waitFor(() => {
      expect(topPreview?.classList.contains(cls(styles.expanded))).toBe(true);
    });
    expect(
      Array.from(
        container.querySelectorAll(`.${cls(styles.preview)}`),
        (preview) => preview.textContent,
      ),
    ).toEqual(initialPreviewTexts);

    const topMarker = screen.getByRole("button", {
      name: `Jump to turn: ${topPreview?.getAttribute("aria-label")}`,
    });
    fireEvent.pointerEnter(topMarker);

    await waitFor(() => {
      const shiftedPreviewTexts = Array.from(
        container.querySelectorAll(`.${cls(styles.preview)}`),
        (preview) => preview.textContent,
      );
      expect(shiftedPreviewTexts).toContain("match snippet 9");
      expect(shiftedPreviewTexts).toContain("match snippet 15");
      expect(shiftedPreviewTexts).not.toContain("match snippet 28");
    });

    const visibleAfterTopHover = Array.from(
      container.querySelectorAll<HTMLElement>(`.${cls(styles.preview)}`),
    );
    const bottomPreview = visibleAfterTopHover[visibleAfterTopHover.length - 1];
    expect(bottomPreview?.textContent).toBe("match snippet 22");
    const bottomMarker = screen.getByRole("button", {
      name: `Jump to turn: ${bottomPreview?.getAttribute("aria-label")}`,
    });
    fireEvent.pointerEnter(bottomMarker);

    await waitFor(() => {
      const shiftedPreviewTexts = Array.from(
        container.querySelectorAll(`.${cls(styles.preview)}`),
        (preview) => preview.textContent,
      );
      expect(shiftedPreviewTexts).toContain("match snippet 28");
      expect(shiftedPreviewTexts).toContain("match snippet 22");
      expect(shiftedPreviewTexts).not.toContain("match snippet 1");
    });
  });

  it("keeps the preview window stable across same-band hash hovers", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = Array.from({ length: 28 }, (_, index) => {
      const row = document.createElement("div");
      row.dataset.renderId = `match-${index + 1}`;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 2000);
    setReadonlyNumber(scrollContainer, "clientHeight", 240);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 100, height: 240 });
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        rect({ top: 110 + index * 8, height: 20 });
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={rows.map((row, index) => ({
          id: row.dataset.renderId ?? "",
          preview: `match snippet ${index + 1}`,
        }))}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "match-26",
          matchIds: new Set(
            rows.map((row) => row.dataset.renderId).filter(Boolean) as string[],
          ),
          preview: "active match snippet",
          query: "match",
          previewsById: new Map(
            rows.map((row, index) => [
              row.dataset.renderId ?? "",
              `match snippet ${index + 1}`,
            ]),
          ),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(`.${cls(styles.preview)}`).length,
      ).toBeGreaterThan(1);
    });

    const getPreviewTexts = () =>
      Array.from(
        container.querySelectorAll(`.${cls(styles.preview)}`),
        (preview) => preview.textContent,
      );
    const initialPreviewTexts = getPreviewTexts();
    const middleVisibleMarker = screen.getByRole("button", {
      name: "Jump to turn: match snippet 20",
    });
    act(() => {
      dispatchElementPointerMove(middleVisibleMarker, 132);
    });
    expect(getPreviewTexts()).toEqual(initialPreviewTexts);

    const offWindowMarker = screen.getByRole("button", {
      name: "Jump to turn: match snippet 1",
    });
    act(() => {
      dispatchElementPointerMove(offWindowMarker, 132);
    });
    expect(getPreviewTexts()).toEqual(initialPreviewTexts);

    act(() => {
      dispatchElementPointerMove(offWindowMarker, 120);
    });
    await waitFor(() => {
      expect(getPreviewTexts()).toContain("match snippet 1");
    });
  });

  it("prefills tall search rails with prior match previews", async () => {
    const scrollContainer = document.createElement("div");
    const messageList = document.createElement("div");
    const rows = Array.from({ length: 70 }, (_, index) => {
      const row = document.createElement("div");
      row.dataset.renderId = `match-${index + 1}`;
      return row;
    });

    messageList.append(...rows);
    scrollContainer.append(messageList);
    document.body.append(scrollContainer);

    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    setReadonlyNumber(scrollContainer, "scrollHeight", 4000);
    setReadonlyNumber(scrollContainer, "clientHeight", 820);
    setReadonlyNumber(scrollContainer, "clientWidth", 360);
    setReadonlyNumber(scrollContainer, "offsetWidth", 380);
    scrollContainer.getBoundingClientRect = () =>
      rect({ top: 80, height: 820 });
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        rect({ top: 650 + index * 8, height: 20 });
    });
    scrollContainer.scrollTo = vi.fn() as typeof scrollContainer.scrollTo;

    const { container } = render(
      <UserTurnNavigator
        anchors={rows.map((row, index) => ({
          id: row.dataset.renderId ?? "",
          preview: `match snippet ${index + 1}`,
        }))}
        messageListRef={{ current: messageList }}
        searchState={{
          activeId: "match-68",
          matchIds: new Set(
            rows.map((row) => row.dataset.renderId).filter(Boolean) as string[],
          ),
          preview: "active match snippet",
          query: "match",
          previewsById: new Map(
            rows.map((row, index) => [
              row.dataset.renderId ?? "",
              `match snippet ${index + 1}`,
            ]),
          ),
        }}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelectorAll(`.${cls(styles.preview)}`).length,
      ).toBeGreaterThan(10);
    });

    const previews = Array.from(
      container.querySelectorAll<HTMLElement>(`.${cls(styles.preview)}`),
    );
    const firstTop = Number.parseFloat(previews[0]?.style.top ?? "");
    expect(firstTop).toBeLessThanOrEqual(24);
    expect(previews.length).toBeGreaterThan(40);
    expect(previews.length).toBeLessThanOrEqual(64);
    expect(previews.map((preview) => preview.textContent)).toContain(
      "match snippet 68",
    );
  });
});
