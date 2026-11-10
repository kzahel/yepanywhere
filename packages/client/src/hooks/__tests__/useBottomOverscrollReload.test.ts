// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  findBottomOverscrollReloadContainer,
  getBottomOverscrollDistance,
  getBottomOverscrollReloadStatus,
  hasSufficientScrollOverflow,
  isScrollContainerAtBottom,
} from "../useBottomOverscrollReload";

function setScrollMetrics(
  element: HTMLElement,
  options: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  },
) {
  Object.defineProperties(element, {
    scrollHeight: {
      configurable: true,
      value: options.scrollHeight,
    },
    clientHeight: {
      configurable: true,
      value: options.clientHeight,
    },
    scrollTop: {
      configurable: true,
      value: options.scrollTop,
      writable: true,
    },
  });
}

describe("useBottomOverscrollReload helpers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds the nearest supported scroll container when it has real overflow", () => {
    const container = document.createElement("main");
    container.setAttribute("data-page-scroll-container", "");
    setScrollMetrics(container, {
      scrollHeight: 720,
      clientHeight: 400,
      scrollTop: 320,
    });

    const child = document.createElement("button");
    container.appendChild(child);
    document.body.appendChild(container);

    expect(findBottomOverscrollReloadContainer(child)).toBe(container);
    expect(hasSufficientScrollOverflow(container)).toBe(true);
    expect(isScrollContainerAtBottom(container)).toBe(true);
  });

  it("ignores interactive targets and non-scrollable containers", () => {
    const container = document.createElement("main");
    container.setAttribute("data-page-scroll-container", "");
    setScrollMetrics(container, {
      scrollHeight: 420,
      clientHeight: 400,
      scrollTop: 20,
    });

    const textarea = document.createElement("textarea");
    container.appendChild(textarea);
    document.body.appendChild(container);

    expect(findBottomOverscrollReloadContainer(textarea)).toBeNull();
    expect(hasSufficientScrollOverflow(container)).toBe(false);
  });

  it("arms only for upward drags that start from the bottom", () => {
    expect(getBottomOverscrollDistance(420, 450)).toBe(0);
    expect(getBottomOverscrollDistance(420, 380)).toBe(40);

    expect(
      getBottomOverscrollReloadStatus({ distancePx: 10, atBottom: true }),
    ).toBe("hidden");
    expect(
      getBottomOverscrollReloadStatus({ distancePx: 24, atBottom: true }),
    ).toBe("pull");
    expect(
      getBottomOverscrollReloadStatus({ distancePx: 96, atBottom: true }),
    ).toBe("armed");
    expect(
      getBottomOverscrollReloadStatus({ distancePx: 96, atBottom: false }),
    ).toBe("hidden");
  });
});
