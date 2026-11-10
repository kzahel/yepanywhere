// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installMessageListTestEnvironment,
  assistantMessage,
  assistantToolUseMessage,
  systemMessage,
  userMessage,
} from "./MessageList.test-support";
import { MessageList } from "../MessageList";
import { requestSessionIsearchOpen } from "../../lib/sessionIsearchGuide";
import { setRecentProjectPathLinksPreference } from "../../hooks/useRecentProjectPathLinks";
import { setReverseSearchMaxPagesPerAttemptPreference } from "../../hooks/useSessionPerformanceSettings";

installMessageListTestEnvironment();

afterEach(() => {
  act(() => setRecentProjectPathLinksPreference(false));
  act(() => setReverseSearchMaxPagesPerAttemptPreference(100));
  vi.unstubAllGlobals();
});

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

function installSearchGeometry(rowOffsets: Record<string, number>) {
  const messageList = document.querySelector<HTMLElement>(
    "[data-message-list]",
  );
  if (!messageList?.parentElement) {
    throw new Error("MessageList did not render a scroll container");
  }
  const scrollContainer = messageList.parentElement;
  let scrollTop = 0;
  const scrollTo = vi.fn(
    (optionsOrX?: ScrollToOptions | number, y?: number) => {
      scrollTop =
        typeof optionsOrX === "number"
          ? optionsOrX
          : Number(optionsOrX?.top ?? y ?? 0);
      scrollContainer.dispatchEvent(new Event("scroll"));
    },
  );

  Object.defineProperty(scrollContainer, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = Number(value);
    },
  });
  setReadonlyNumber(scrollContainer, "scrollHeight", 1800);
  setReadonlyNumber(scrollContainer, "clientHeight", 200);
  setReadonlyNumber(scrollContainer, "clientWidth", 360);
  setReadonlyNumber(scrollContainer, "offsetWidth", 380);
  scrollContainer.getBoundingClientRect = () => rect({ top: 100, height: 200 });
  Object.defineProperty(scrollContainer, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });

  const installRowGeometry = () => {
    for (const row of messageList.querySelectorAll<HTMLElement>(
      "[data-render-id]",
    )) {
      const renderId = row.dataset.renderId;
      const topOffset = renderId ? rowOffsets[renderId] : undefined;
      if (topOffset === undefined) {
        continue;
      }
      row.getBoundingClientRect = () =>
        rect({ top: 100 + topOffset - scrollTop, height: 24 });
    }
  };
  installRowGeometry();
  const observer = new MutationObserver(installRowGeometry);
  observer.observe(messageList, { childList: true, subtree: true });

  return {
    scrollTo,
    getScrollTop: () => scrollTop,
    stop: () => observer.disconnect(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function historyPage(
  messages: ReturnType<typeof userMessage>[],
  nextCursor: string | null,
) {
  return {
    session: {},
    messages,
    ownership: "unowned",
    pagination: {
      hasOlderMessages: nextCursor !== null,
      totalMessageCount: messages.length,
      returnedMessageCount: messages.length,
      ...(nextCursor ? { truncatedBeforeMessageId: nextCursor } : {}),
      totalCompactions: 0,
    },
  } as never;
}

describe("MessageList reverse search", () => {
  it.each(["Escape", "click"] as const)(
    "holds a match dismissed with %s after an earlier bottom event re-enabled Follow",
    async (dismiss) => {
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(
        (callback) => {
          frames.set(++frameId, callback);
          return frameId;
        },
      );
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        frames.delete(id);
      });
      const observers: {
        callback: ResizeObserverCallback;
        targets: Element[];
        active: boolean;
      }[] = [];
      class CapturingResizeObserver {
        targets: Element[] = [];
        active = true;
        constructor(readonly callback: ResizeObserverCallback) {
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        disconnect() {
          this.active = false;
        }
      }
      vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
      const following = vi.fn();
      const { container } = render(
        <MessageList
          onFollowingBottomChange={following}
          messages={[
            userMessage("user-1", "setup request"),
            assistantMessage("assistant-1", "needle answer"),
            userMessage("user-2", "later setup"),
            assistantMessage("assistant-2", "later answer"),
          ]}
        />,
      );
      const geometry = installSearchGeometry({
        "user-1": 20,
        "assistant-1": 900,
        "user-2": 1300,
        "assistant-2": 1500,
      });
      const flushFrames = () => {
        for (let round = 0; round < 8 && frames.size; round++) {
          const pending = [...frames.keys()];
          act(() => {
            for (const id of pending) {
              const callback = frames.get(id);
              if (!callback) continue;
              frames.delete(id);
              callback(performance.now());
            }
          });
        }
      };
      const resize = () =>
        act(() => {
          for (const observer of observers) {
            if (!observer.active || !observer.targets.includes(container))
              continue;
            observer.callback([], {} as ResizeObserver);
          }
        });
      resize();
      flushFrames();
      expect(geometry.getScrollTop()).toBe(1600);
      fireEvent.keyDown(window, { key: "s", ctrlKey: true });
      fireEvent.change(
        screen.getByRole("textbox", { name: "Reverse search all turns" }),
        { target: { value: "needle" } },
      );
      flushFrames();
      await act(async () => {});
      flushFrames();
      fireEvent.click(
        await screen.findByRole("button", { name: "needle answer" }),
      );
      await act(async () => {});
      flushFrames();
      // At the rendered tail, the native event can re-acquire Follow. The next
      // scroll write has not dispatched its event when Escape closes search.
      const lastChild = container.querySelector("[data-message-list]")!
        .lastElementChild!;
      vi.spyOn(lastChild, "getBoundingClientRect").mockReturnValueOnce(
        rect({ top: 276, height: 24 }),
      );
      fireEvent.scroll(container);
      expect(following).toHaveBeenLastCalledWith(true);
      container.scrollTop -= 60;
      const heldTop = geometry.getScrollTop();
      expect(heldTop).toBe(752);
      if (dismiss === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else
        fireEvent.click(
          container.querySelector('[data-render-id="assistant-1"]')!,
        );
      expect(screen.queryByRole("search")).toBeNull();
      expect(following).toHaveBeenLastCalledWith(false);
      // The queued reader event arrives while forced-anchor restoration owns
      // the programmatic flag; it cannot repair stale Follow intent itself.
      fireEvent.scroll(container);
      setReadonlyNumber(container, "scrollHeight", 1860);
      resize();
      flushFrames();
      expect(geometry.getScrollTop()).toBe(heldTop);
      fireEvent.click(
        screen.getByRole("button", { name: "Follow latest session output" }),
      );
      flushFrames();
      expect(geometry.getScrollTop()).toBe(1660);
      setReadonlyNumber(container, "scrollHeight", 1960);
      resize();
      expect(geometry.getScrollTop()).toBe(1760);
      geometry.stop();
    },
  );

  it("preserves the query and case when Ctrl+Alt+S changes scope", async () => {
    render(<MessageList messages={[userMessage("first", "Needle first")]} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search user turns" }),
      { target: { value: "Needle" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Case-sensitive search" }),
    );
    fireEvent.keyDown(window, { key: "s", ctrlKey: true, altKey: true });
    expect(
      (
        screen.getByRole("textbox", {
          name: "Reverse search full session",
        }) as HTMLInputElement
      ).value,
    ).toBe("Needle");
    expect(
      screen
        .getByRole("button", { name: "Case-sensitive search" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("focuses the query input without waiting for an animation frame", async () => {
    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    render(<MessageList messages={[userMessage("first", "Horizon needle")]} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = (await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    })) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 0]);
  });

  it("opens from a toolbar request with focus inside the tap, in the last scope", () => {
    render(<MessageList messages={[userMessage("first", "Horizon needle")]} />);
    // No await: the input must hold focus before the dispatching tap returns,
    // or a touch keyboard will not open.
    act(() => requestSessionIsearchOpen());
    const userInput = screen.getByRole("textbox", {
      name: "Reverse search user turns",
    });
    expect(document.activeElement).toBe(userInput);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("textbox", { name: "Reverse search user turns" }),
    ).toBeNull();

    act(() => requestSessionIsearchOpen());
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Reverse search link labels" }),
    );
  });

  it("routes keys typed before the input takes focus into the query", async () => {
    const focus = vi
      .spyOn(HTMLInputElement.prototype, "focus")
      .mockImplementation(() => {});
    render(<MessageList messages={[userMessage("first", "Horizon needle")]} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = (await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    })) as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    for (const key of ["h", "o", "x"]) {
      fireEvent.keyDown(window, { key });
    }
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(input.value).toBe("ho");
    focus.mockRestore();
  });

  it("stops intercepting keys once the input holds focus", async () => {
    render(<MessageList messages={[userMessage("first", "Horizon needle")]} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = (await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    })) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.blur();
    fireEvent.keyDown(window, { key: "x" });
    expect(input.value).toBe("");
  });

  it("hands over to a focused input that rewrites its own text", async () => {
    const focus = vi
      .spyOn(HTMLInputElement.prototype, "focus")
      .mockImplementation(() => {});
    render(<MessageList messages={[userMessage("first", "Horizon needle")]} />);
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = (await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    })) as HTMLInputElement;
    // fireEvent returns false when a handler called preventDefault, which is
    // how the receiver announces that it took the key instead of the field.
    expect(fireEvent.keyDown(window, { key: "h" })).toBe(false);
    expect(input.value).toBe("h");
    focus.mockRestore();
    // A field whose value never equals the query would keep the receiver in
    // front of it forever; the attempt bound retires it instead.
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "rewritten",
    });
    input.focus();
    expect(fireEvent.keyDown(window, { key: "o" })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "o" })).toBe(true);
  });

  it("waits for an older page and advances to k of n+k with honest coverage", async () => {
    const pending = deferred<ReturnType<typeof historyPage>>();
    const read = vi.fn(() => pending.promise);
    render(
      <MessageList
        messages={[userMessage("recent", "needle recent")]}
        hasOlderMessages
        olderMessagesCursor="boundary"
        totalMessageCount={4}
        onReadOlderSearchPage={read}
      />,
    );
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search user turns" }),
      { target: { value: "needle" } },
    );
    expect(
      screen.getByLabelText("Percentage of session messages checked")
        .textContent,
    ).toBe("25%");
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("1/1")).toBeTruthy();
    expect(screen.getByText("Searching…")).toBeTruthy();
    await act(async () =>
      pending.resolve(
        historyPage(
          [
            userMessage("oldest", "needle oldest"),
            userMessage("older", "needle older"),
          ],
          "more",
        ),
      ),
    );
    expect(await screen.findByText("2/3")).toBeTruthy();
    expect(
      screen.getByLabelText("Percentage of session messages checked")
        .textContent,
    ).toBe("75%");
  });

  it("announces the search boundary and cycles without another press", async () => {
    render(
      <MessageList
        messages={[
          userMessage("first", "needle first"),
          userMessage("last", "needle last"),
        ]}
      />,
    );
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search user turns" }),
      { target: { value: "needle" } },
    );
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    expect(screen.getByText("Start of session · wrapped")).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("activates an older preview by click and provides Go", async () => {
    const read = vi.fn(async () =>
      historyPage([userMessage("old", "needle old")], null),
    );
    const { container } = render(
      <MessageList
        messages={[userMessage("recent", "recent request")]}
        hasOlderMessages
        olderMessagesCursor="boundary"
        onReadOlderSearchPage={read}
      />,
    );
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search user turns" }),
      { target: { value: "needle" } },
    );
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.click(await screen.findByText("needle old"));
    await waitFor(() =>
      expect(container.querySelector('[data-render-id="old"]')).not.toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Go to selected match" }),
    );
    await waitFor(() => expect(screen.queryByRole("search")).toBeNull());
  });

  it.each([
    {
      shortcut: "r",
      inputName: "Reverse search user turns",
      targetId: "user-0",
      needle: "oldest user needle",
    },
    {
      shortcut: "s",
      inputName: "Reverse search all turns",
      targetId: "assistant-0",
      needle: "oldest assistant needle",
    },
  ])(
    "wakes and keeps an off-window $shortcut match aligned after commit",
    async ({ shortcut, inputName, targetId, needle }) => {
      const messages = Array.from({ length: 130 }, (_, index) => [
        userMessage(
          `user-${index}`,
          index === 0 ? "oldest user needle" : `Request ${index}`,
        ),
        assistantMessage(
          `assistant-${index}`,
          index === 0 ? "oldest assistant needle" : `Answer ${index}`,
        ),
      ]).flat();
      const { container } = render(<MessageList messages={messages} />);

      expect(
        container.querySelector(`[data-render-id="${targetId}"]`),
      ).toBeNull();
      expect(
        container.querySelectorAll("[data-render-id]").length,
      ).toBeLessThanOrEqual(48);

      // Own geometry before the initial layout settles. Otherwise its queued
      // bottom positioning can consume newly installed metrics during search.
      const { scrollTo, getScrollTop, stop } = installSearchGeometry({
        [targetId]: 900,
      });
      await waitFor(() => expect(getScrollTop()).toBe(1600));
      fireEvent.keyDown(window, { key: shortcut, ctrlKey: true });
      const input = await screen.findByRole("textbox", { name: inputName });
      fireEvent.change(input, { target: { value: needle } });
      await waitFor(() => {
        expect(
          container.querySelector(`[data-render-id="${targetId}"]`),
        ).not.toBeNull();
      });
      fireEvent.keyDown(window, { key: "Enter" });

      await waitFor(() => {
        expect(screen.queryByRole("textbox", { name: inputName })).toBeNull();
        expect(
          container.querySelector(`[data-render-id="${targetId}"]`),
        ).not.toBeNull();
      });
      // Closing the search commits before its deferred scroll alignment.
      // Observe the alignment itself rather than only the removed textbox.
      await waitFor(() => {
        expect(scrollTo).toHaveBeenCalledWith({ top: 812, behavior: "auto" });
        expect(getScrollTop()).toBe(812);
      });
      expect(
        container.querySelectorAll("[data-render-id]").length,
      ).toBeLessThanOrEqual(48);
      stop();
    },
  );

  it("opens reverse user-turn search with Ctrl+R and hides nonmatches", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "alpha setup request"),
          assistantMessage("assistant-1", "first response"),
          userMessage(
            "user-2",
            "please inspect the render latency regression in the client",
          ),
          assistantMessage("assistant-2", "second response"),
        ]}
      />,
    );

    const editableTarget = document.createElement("textarea");
    document.body.append(editableTarget);
    editableTarget.focus();
    fireEvent.keyDown(editableTarget, { key: "r", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    expect(composerTarget.contains(input)).toBe(true);
    expect(screen.getByText("2+ chars")).toBeTruthy();

    fireEvent.change(input, { target: { value: "latency" } });

    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.queryByText("alpha setup request")).toBeNull();
    expect(screen.getByText(/render latency regression/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(editableTarget);
    });
    editableTarget.remove();
    composerTarget.remove();
  });

  it("clears a selected search id when its trimmed turn disappears", async () => {
    const retained = userMessage("user-2", "retained searchable request");
    const rendered = render(
      <MessageList
        messages={[userMessage("user-1", "unique removed needle"), retained]}
        activeWindowTrimRevision={0}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();

    rendered.rerender(
      <MessageList messages={[retained]} activeWindowTrimRevision={1} />,
    );

    expect(await screen.findByText("0/0")).toBeTruthy();
    expect(screen.queryByText("unique removed needle")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Reverse search user turns" }),
    ).toBe(input);
  });

  it("opens user-turn search with Ctrl+Alt+R fallback for one turn", async () => {
    render(
      <MessageList
        messages={[userMessage("user-1", "inspect Chrome shortcut handling")]}
      />,
    );

    fireEvent.keyDown(window, {
      key: "R",
      code: "KeyR",
      ctrlKey: true,
      altKey: true,
    });

    expect(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
    ).toBeTruthy();
  });

  it("keeps reverse search active when focus moves outside its panel", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first searchable request"),
          userMessage("user-2", "second searchable request"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    const composer = document.createElement("textarea");
    document.body.append(composer);

    fireEvent.blur(input, { relatedTarget: composer });

    expect(
      screen.getByRole("textbox", { name: "Reverse search user turns" }),
    ).toBe(input);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search user turns" }),
      ).toBeNull();
    });
    composer.remove();
  });

  it("scans older pages as excerpts and hydrates only the chosen page", async () => {
    const firstOlderPage = {
      session: {},
      messages: [
        userMessage("user-middle", "an intermediate page without the term"),
      ],
      ownership: "unowned",
      pagination: {
        hasOlderMessages: true,
        totalMessageCount: 6,
        returnedMessageCount: 1,
        truncatedBeforeMessageId: "older-boundary",
        totalCompactions: 3,
      },
    } as never;
    const matchingOlderPage = {
      session: {},
      messages: [
        userMessage("user-old", "the buried history needle lives here"),
        assistantMessage("assistant-old", "old answer"),
      ],
      ownership: "unowned",
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 6,
        returnedMessageCount: 2,
        totalCompactions: 3,
      },
    } as never;
    const readOlderPage = vi.fn(async (cursor: string) =>
      cursor === "loaded-boundary" ? firstOlderPage : matchingOlderPage,
    );
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-recent", "recent request"),
          assistantMessage("assistant-recent", "recent answer"),
        ]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(input, { target: { value: "history needle" } });

    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    expect(await screen.findByRole("button", { name: "More" })).toBeTruthy();
    expect(readOlderPage).toHaveBeenLastCalledWith("loaded-boundary");
    expect(
      container.querySelector('[data-render-id="user-middle"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByText("Older result")).toBeTruthy();
    expect(screen.getByText(/buried history needle lives here/)).toBeTruthy();
    expect(readOlderPage).toHaveBeenLastCalledWith("older-boundary");
    expect(container.querySelector('[data-render-id="user-old"]')).toBeNull();

    const { scrollTo, stop } = installSearchGeometry({ "user-old": 900 });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-old"]'),
      ).not.toBeNull();
    });
    expect(readOlderPage).toHaveBeenCalledTimes(3);
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 812, behavior: "auto" });
    });
    expect(screen.queryByText("Older result")).toBeNull();
    expect(
      screen.getByText(
        "Unloaded history omitted · recent transcript continues below",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-recent"]'),
      ).not.toBeNull();
    });

    fireEvent.keyDown(window, { key: "End", ctrlKey: true });
    await waitFor(() => {
      expect(container.querySelector('[data-render-id="user-old"]')).toBeNull();
    });
    stop();
  });

  it.each([
    {
      label: "Ctrl+R",
      open: () => fireEvent.keyDown(window, { key: "r", ctrlKey: true }),
      extend: () => fireEvent.keyDown(window, { key: "r", ctrlKey: true }),
      inputName: "Reverse search user turns",
    },
    {
      label: "Ctrl+S",
      open: () => fireEvent.keyDown(window, { key: "s", ctrlKey: true }),
      extend: () => fireEvent.keyDown(window, { key: "s", ctrlKey: true }),
      inputName: "Reverse search all turns",
    },
    {
      label: "ArrowUp",
      open: () => fireEvent.keyDown(window, { key: "r", ctrlKey: true }),
      extend: () => fireEvent.keyDown(window, { key: "ArrowUp" }),
      inputName: "Reverse search user turns",
    },
  ])(
    "extends at the oldest match with $label until another match",
    async ({ extend, inputName, open }) => {
      const pages = new Map([
        [
          "loaded-boundary",
          historyPage(
            [userMessage("user-middle", "an intermediate page")],
            "older-boundary",
          ),
        ],
        [
          "older-boundary",
          historyPage(
            [userMessage("user-old", "the older needle match")],
            null,
          ),
        ],
      ]);
      const readOlderPage = vi.fn(async (cursor: string) => pages.get(cursor)!);
      render(
        <MessageList
          messages={[userMessage("user-recent", "the recent needle match")]}
          hasOlderMessages={true}
          olderMessagesCursor="loaded-boundary"
          onReadOlderSearchPage={readOlderPage}
        />,
      );

      open();
      fireEvent.change(
        await screen.findByRole("textbox", {
          name: inputName,
        }),
        { target: { value: "needle match" } },
      );
      expect(await screen.findByText("1/1")).toBeTruthy();

      extend();

      expect(await screen.findByText("1/2")).toBeTruthy();
      expect(readOlderPage).toHaveBeenCalledTimes(2);
      expect(readOlderPage).toHaveBeenNthCalledWith(1, "loaded-boundary");
      expect(readOlderPage).toHaveBeenNthCalledWith(2, "older-boundary");
    },
  );

  it("stops one keyboard extension at the configured page limit", async () => {
    act(() => setReverseSearchMaxPagesPerAttemptPreference(2));
    const pages = new Map([
      ["page-1", historyPage([userMessage("user-1", "no match")], "page-2")],
      [
        "page-2",
        historyPage([userMessage("user-2", "still absent")], "page-3"),
      ],
      ["page-3", historyPage([userMessage("user-3", "old needle")], null)],
    ]);
    const readOlderPage = vi.fn(async (cursor: string) => pages.get(cursor)!);
    render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="page-1"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "old needle" } },
    );
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });

    await waitFor(() => expect(readOlderPage).toHaveBeenCalledTimes(2));
    // The second read having started is not the same as its result having
    // rendered; wait for the settled panel rather than the call count.
    expect(await screen.findByText("0/0")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "More" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(readOlderPage).toHaveBeenCalledTimes(3);
  });

  it("drops an active older-page search when basename linking changes", async () => {
    const stalePageRead = deferred<ReturnType<typeof historyPage>>();
    const readOlderPage = vi
      .fn<(cursor: string) => Promise<ReturnType<typeof historyPage>>>()
      .mockImplementationOnce(() => stalePageRead.promise)
      .mockResolvedValueOnce(historyPage([], null));
    render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage as never}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "stale projection needle" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    await waitFor(() => expect(readOlderPage).toHaveBeenCalledOnce());

    act(() => setRecentProjectPathLinksPreference(true));
    await act(async () => {
      stalePageRead.resolve(
        historyPage(
          [userMessage("user-stale", "stale projection needle")],
          null,
        ),
      );
      await stalePageRead.promise;
    });

    expect(screen.queryByText("Older result")).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    await waitFor(() => expect(readOlderPage).toHaveBeenCalledTimes(2));
  });

  it("keeps the latest historical selection when hydrations settle out of order", async () => {
    const pageA = historyPage(
      [userMessage("user-history-a", "history A needle")],
      "history-b-boundary",
    );
    const pageB = historyPage(
      [userMessage("user-history-b", "history B needle")],
      null,
    );
    const hydrationA = deferred<typeof pageA>();
    const hydrationB = deferred<typeof pageB>();
    let pageAReads = 0;
    let pageBReads = 0;
    const readOlderPage = vi.fn((cursor: string) => {
      if (cursor === "loaded-boundary") {
        pageAReads += 1;
        return pageAReads === 1 ? Promise.resolve(pageA) : hydrationA.promise;
      }
      pageBReads += 1;
      return pageBReads === 1 ? Promise.resolve(pageB) : hydrationB.promise;
    });
    const { container } = render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const searchInput = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(searchInput, { target: { value: "needle" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "More" }));

    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() => expect(pageAReads).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(window, { key: "r", code: "KeyR", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() => expect(pageBReads).toBe(2));

    act(() => hydrationB.resolve(pageB));
    await waitFor(() => {
      expect(
        container.querySelector('[data-render-id="user-history-b"]'),
      ).not.toBeNull();
    });
    act(() => hydrationA.resolve(pageA));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-render-id="user-history-a"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-render-id="user-history-b"]'),
    ).not.toBeNull();
  });

  it("does not remount historical hydration after following current output", async () => {
    const page = historyPage(
      [userMessage("user-history", "historical follow needle")],
      null,
    );
    const hydration = deferred<typeof page>();
    let reads = 0;
    const readOlderPage = vi.fn(() => {
      reads += 1;
      return reads === 1 ? Promise.resolve(page) : hydration.promise;
    });
    const { container } = render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const searchInput = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(searchInput, { target: { value: "follow needle" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    await screen.findByText("Older result");
    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() => expect(reads).toBe(2));

    fireEvent.keyDown(window, { key: "End", ctrlKey: true });
    act(() => hydration.resolve(page));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-render-id="user-history"]'),
    ).toBeNull();
  });

  it("does not resurrect a hydrated page after park or view changes", async () => {
    const page = historyPage(
      [userMessage("user-history", "historical lifetime needle")],
      null,
    );
    const readOlderPage = vi.fn(async () => page);
    const renderList = (
      inert = false,
      conversationViewEnabledOverride = false,
    ) => (
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
        inert={inert}
        conversationViewEnabledOverride={conversationViewEnabledOverride}
      />
    );
    const rendered = render(renderList());
    const hydrateSelectedPage = async () => {
      fireEvent.keyDown(window, { key: "r", ctrlKey: true });
      fireEvent.change(
        await screen.findByRole("textbox", {
          name: "Reverse search user turns",
        }),
        { target: { value: "lifetime needle" } },
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Search older" }),
      );
      await screen.findByText("Older result");
      fireEvent.keyDown(window, { key: "Enter" });
      await waitFor(() => {
        expect(
          rendered.container.querySelector('[data-render-id="user-history"]'),
        ).not.toBeNull();
      });
      await waitFor(() => {
        expect(
          screen.queryByRole("textbox", {
            name: "Reverse search user turns",
          }),
        ).toBeNull();
      });
    };

    await hydrateSelectedPage();
    rendered.rerender(renderList(true));
    rendered.rerender(renderList(false));
    expect(
      rendered.container.querySelector('[data-render-id="user-history"]'),
    ).toBeNull();

    await hydrateSelectedPage();
    rendered.rerender(renderList(false, true));
    rendered.rerender(renderList(false, false));
    expect(
      rendered.container.querySelector('[data-render-id="user-history"]'),
    ).toBeNull();
  });

  it("restores prompt actions when pagination canonically loads a historical row", async () => {
    const historicalMessage = userMessage(
      "user-history",
      "historical canonical needle",
    );
    const page = historyPage([historicalMessage], null);
    const readOlderPage = vi.fn(async () => page);
    const onTrimBeforeUserMessage = vi.fn();
    const recentMessage = userMessage("user-recent", "recent request");
    const renderList = (messages: ReturnType<typeof userMessage>[]) => (
      <MessageList
        messages={messages}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
        onTrimBeforeUserMessage={onTrimBeforeUserMessage}
      />
    );
    const rendered = render(renderList([recentMessage]));

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "canonical needle" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    await screen.findByText("Older result");
    fireEvent.keyDown(window, { key: "Enter" });
    const hydratedHistoricalRow = await waitFor(() => {
      const row = rendered.container.querySelector<HTMLElement>(
        '[data-render-id="user-history"]',
      );
      expect(row).not.toBeNull();
      return row!;
    });
    expect(
      within(hydratedHistoricalRow).queryByRole("button", {
        name: "userPromptShowStartingHere",
      }),
    ).toBeNull();

    rendered.rerender(renderList([historicalMessage, recentMessage]));

    const historicalRow = rendered.container.querySelector<HTMLElement>(
      '[data-render-id="user-history"]',
    );
    expect(historicalRow).not.toBeNull();
    const trim = within(historicalRow!).getByRole("button", {
      name: "userPromptShowStartingHere",
    });
    fireEvent.click(trim);
    expect(onTrimBeforeUserMessage).toHaveBeenCalledWith("user-history");
  });

  it("keeps the closest 512 matches across three older pages", async () => {
    const pages = new Map([
      [
        "closest-boundary",
        historyPage(
          Array.from({ length: 200 }, (_, index) =>
            userMessage(`closest-${index}`, `closest ${index} needle`),
          ),
          "middle-boundary",
        ),
      ],
      [
        "middle-boundary",
        historyPage(
          Array.from({ length: 200 }, (_, index) =>
            userMessage(`middle-${index}`, `middle ${index} needle`),
          ),
          "oldest-boundary",
        ),
      ],
      [
        "oldest-boundary",
        historyPage(
          Array.from({ length: 200 }, (_, index) =>
            userMessage(`oldest-${index}`, `oldest ${index} needle`),
          ),
          null,
        ),
      ],
    ]);
    const readOlderPage = vi.fn(async (cursor: string) => pages.get(cursor)!);

    render(
      <MessageList
        messages={[userMessage("user-recent", "recent request")]}
        hasOlderMessages={true}
        olderMessagesCursor="closest-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "needle" } },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Search older" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));

    expect(await screen.findByText("512/512")).toBeTruthy();
    expect(screen.getByText("closest 199 needle")).toBeTruthy();
    expect(screen.queryByText("oldest 0 needle")).toBeNull();
  });

  it("does not create the history worker before an explicit older search", async () => {
    let workerConstructions = 0;
    class TestWorker {
      private messageListeners: Array<
        (event: MessageEvent<Record<string, unknown>>) => void
      > = [];

      constructor() {
        workerConstructions += 1;
      }

      addEventListener(
        type: string,
        listener: (event: MessageEvent<Record<string, unknown>>) => void,
      ) {
        if (type === "message") this.messageListeners.push(listener);
      }

      postMessage(request: Record<string, unknown>) {
        const { requestId } = request;
        queueMicrotask(() => {
          for (const listener of this.messageListeners) {
            listener(
              new MessageEvent("message", {
                data: { requestId, matches: [], matchesTruncated: false },
              }),
            );
          }
        });
      }

      terminate() {}
    }
    vi.stubGlobal("Worker", TestWorker);
    const readOlderPage = vi.fn(async () => ({
      session: {},
      messages: [],
      ownership: "unowned",
      pagination: {
        hasOlderMessages: false,
        totalMessageCount: 1,
        returnedMessageCount: 0,
        totalCompactions: 0,
      },
    })) as never;

    render(
      <MessageList
        messages={[assistantMessage("assistant-recent", "recent answer")]}
        hasOlderMessages={true}
        olderMessagesCursor="loaded-boundary"
        onReadOlderSearchPage={readOlderPage}
      />,
    );

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search user turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });

    expect(workerConstructions).toBe(0);
    expect(readOlderPage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Search older" }));
    await waitFor(() => expect(workerConstructions).toBe(1));
    expect(readOlderPage).toHaveBeenCalledOnce();
  });

  it("opens all-turn reverse search with Ctrl+S", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "look at the first thing"),
          assistantMessage("assistant-1", "the assistant found needle text"),
          systemMessage("system-1", "system compacted needle context"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    expect(screen.getByText("All turns")).toBeTruthy();

    fireEvent.change(input, { target: { value: "needle" } });

    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(await screen.findByText("2/2")).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByText("look at the first thing")).toBeNull();
    expect(screen.getByText("the assistant found needle text")).toBeTruthy();
    expect(screen.getByText("system compacted needle context")).toBeTruthy();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("centers a clicked all-turn preview without a blur-time re-jump", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "unmatched setup request"),
          assistantMessage("assistant-1", "assistant needle answer"),
          userMessage("user-2", "later unmatched request"),
          assistantMessage("assistant-2", "later unmatched answer"),
        ]}
      />,
    );

    const { scrollTo } = installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });

    const preview = await screen.findByRole("button", {
      name: "assistant needle answer",
    });
    fireEvent.click(preview);

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    });
    expect(
      screen.getByRole("textbox", { name: "Reverse search all turns" }),
    ).toBe(input);
    const scrollCallCount = scrollTo.mock.calls.length;
    const transcriptControl = document.createElement("button");
    document.body.append(transcriptControl);

    fireEvent.blur(input, { relatedTarget: transcriptControl });

    expect(
      screen.getByRole("textbox", { name: "Reverse search all turns" }),
    ).toBe(input);
    expect(scrollTo).toHaveBeenCalledTimes(scrollCallCount);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });
    expect(scrollTo).toHaveBeenCalledTimes(scrollCallCount);
    expect(screen.getByText("unmatched setup request")).toBeTruthy();
    transcriptControl.remove();
  });

  it("Enter after arrowing to a match jumps like clicking that match", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    const flushAnimationFrames = () => {
      act(() => {
        const pending = rafQueue.splice(0);
        for (const callback of pending) {
          callback(0);
        }
      });
    };

    render(
      <MessageList
        messages={[
          userMessage("user-1", "unmatched setup request"),
          assistantMessage("assistant-1", "first needle answer"),
          userMessage("user-2", "later unmatched request"),
          assistantMessage("assistant-2", "second needle answer"),
        ]}
      />,
    );
    const { scrollTo } = installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search all turns" }),
      { target: { value: "needle" } },
    );
    expect(await screen.findByText("2/2")).toBeTruthy();
    flushAnimationFrames();
    const preview = await screen.findByRole("button", {
      name: "first needle answer",
    });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Enter" });

    // Same destination as clicking `preview` (offset 420, centered in 200px).
    expect(preview).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });
    installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });
    flushAnimationFrames();
    flushAnimationFrames();
    expect(screen.getByText("unmatched setup request")).toBeTruthy();
    expect(screen.getByText("first needle answer")).toBeTruthy();
    composerTarget.remove();
  });

  it("Ctrl+R Enter after arrowing jumps to the highlighted user turn", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first needle request"),
          assistantMessage("assistant-1", "first answer"),
          userMessage("user-2", "second needle request"),
          assistantMessage("assistant-2", "second answer"),
        ]}
      />,
    );

    const { scrollTo } = installSearchGeometry({
      "user-1": 420,
      "assistant-1": 700,
      "user-2": 1100,
      "assistant-2": 1400,
    });

    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Reverse search user turns",
      }),
      { target: { value: "needle" } },
    );
    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Enter" });

    expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search user turns" }),
      ).toBeNull();
    });
    composerTarget.remove();
  });

  it("Enter after arrowing in conversation view pins the same match", async () => {
    const composerTarget = document.createElement("div");
    composerTarget.setAttribute("data-session-input-inner", "");
    document.body.append(composerTarget);

    const rafQueue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    const flushAnimationFrames = () => {
      act(() => {
        const pending = rafQueue.splice(0);
        for (const callback of pending) {
          callback(0);
        }
      });
    };

    render(
      <MessageList
        conversationViewEnabledOverride
        messages={[
          userMessage("user-1", "unmatched setup request"),
          assistantToolUseMessage("assistant-tools-1", [
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { file_path: "packages/client/src/recap.ts" },
            },
          ]),
          assistantMessage("assistant-1", "first needle answer"),
          userMessage("user-2", "later unmatched request"),
          assistantToolUseMessage("assistant-tools-2", [
            {
              type: "tool_use",
              id: "read-2",
              name: "Read",
              input: { file_path: "packages/client/src/notice.ts" },
            },
          ]),
          assistantMessage("assistant-2", "second needle answer"),
        ]}
      />,
    );

    const { scrollTo } = installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Reverse search all turns" }),
      { target: { value: "needle" } },
    );
    expect(await screen.findByText("2/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(await screen.findByText("1/2")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Enter" });

    expect(scrollTo).toHaveBeenCalledWith({ top: 332, behavior: "auto" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });
    installSearchGeometry({
      "user-1": 20,
      "assistant-1": 420,
      "user-2": 900,
      "assistant-2": 1320,
    });
    flushAnimationFrames();
    flushAnimationFrames();
    expect(screen.getByText("first needle answer")).toBeTruthy();
    composerTarget.remove();
  });

  it("repeats all-turn search arrow movement at a fast cadence", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "needle in the first request"),
          assistantMessage("assistant-1", "needle in the first answer"),
          systemMessage("system-1", "needle in the compacted context"),
          assistantMessage("assistant-2", "needle in the final answer"),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const input = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(input, { target: { value: "needle" } });
    expect(await screen.findByText("4/4")).toBeTruthy();

    vi.useFakeTimers();

    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByText("3/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("2/4")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(42);
    });
    expect(screen.getByText("1/4")).toBeTruthy();

    fireEvent.keyUp(window, { key: "ArrowUp" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  it("opens full-session reverse search with Ctrl+Alt+S for tool groups", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect recent changes"),
          assistantToolUseMessage("assistant-tools", [
            {
              type: "tool_use",
              id: "grep-1",
              name: "Grep",
              input: {
                pattern: "SearchNeedle",
                path: "packages/client/src/components/MessageList.tsx",
              },
            },
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: {
                file_path:
                  "packages/client/src/components/UserTurnNavigator.tsx",
              },
            },
          ]),
        ]}
      />,
    );

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    const allInput = await screen.findByRole("textbox", {
      name: "Reverse search all turns",
    });
    fireEvent.change(allInput, { target: { value: "Explored" } });

    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Reverse search all turns" }),
      ).toBeNull();
    });

    fireEvent.keyDown(window, {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
      altKey: true,
    });

    const fullInput = await screen.findByRole("textbox", {
      name: "Reverse search full session",
    });
    expect(screen.getByText("Full session")).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Alt\+S prev/)).toBeTruthy();
    expect(screen.getByText(/click jumps/)).toBeTruthy();
    expect(screen.getByText(/Enter jump\+close/)).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "Explored" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Exploring")).toBeTruthy();

    fireEvent.change(fullInput, {
      target: { value: "UserTurnNavigator.tsx" },
    });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "grep" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
    expect(screen.getByText("Grep")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "searchneedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Case-sensitive search" }),
    );
    expect(await screen.findByText("0/0")).toBeTruthy();

    fireEvent.change(fullInput, { target: { value: "SearchNeedle" } });
    expect(await screen.findByText("1/1")).toBeTruthy();
  });
});
