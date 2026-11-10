// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNativePullToRefresh } from "../useNativePullToRefresh";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function touch(target: HTMLElement, type: string, x = 100, y = 100, count = 1) {
  act(() => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", {
      value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })),
    });
    target.dispatchEvent(event);
  });
}

function setup() {
  const reload = vi.fn();
  const { result } = renderHook(() => useNativePullToRefresh(reload));
  const page = document.createElement("main");
  page.setAttribute("data-page-scroll-container", "");
  document.body.appendChild(page);
  return { reload, result, page };
}

it("refreshes a fitting page from its top only after release", () => {
  const { reload, result, page } = setup();
  touch(page, "touchstart");
  touch(page, "touchmove", 100, 130);
  expect(result.current).toBe("pull");
  touch(page, "touchmove", 100, 200);
  expect(result.current).toBe("armed");
  expect(reload).not.toHaveBeenCalled();
  touch(page, "touchend");
  expect(reload).toHaveBeenCalledOnce();
  expect(result.current).toBe("hidden");
});

it("ignores cancellation, multitouch, horizontal movement and scrolling to the top", () => {
  const { reload, page } = setup();
  touch(page, "touchstart");
  touch(page, "touchmove", 100, 200);
  touch(page, "touchcancel");
  touch(page, "touchstart");
  touch(page, "touchmove", 100, 200, 2);
  touch(page, "touchend");
  touch(page, "touchstart");
  touch(page, "touchmove", 220, 150);
  touch(page, "touchmove", 220, 250);
  touch(page, "touchend");
  page.scrollTop = 20;
  touch(page, "touchstart");
  page.scrollTop = 0;
  touch(page, "touchmove", 100, 200);
  touch(page, "touchend");
  expect(reload).not.toHaveBeenCalled();
});

it("leaves inputs and nested scrolling to their owners", () => {
  const { reload, page } = setup();
  const input = document.createElement("textarea");
  const nested = document.createElement("div");
  nested.style.overflowY = "auto";
  Object.defineProperty(nested, "scrollHeight", { value: 1000 });
  page.append(input, nested);
  for (const target of [input, nested]) {
    touch(target, "touchstart");
    touch(target, "touchmove", 100, 200);
    touch(target, "touchend");
  }
  expect(reload).not.toHaveBeenCalled();
});
