import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SessionLivenessSnapshot } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLivenessProvider } from "../../contexts/SessionLivenessContext";
import { ProcessingIndicator } from "../ProcessingIndicator";

let nextAnimationFrameId = 1;
let animationFrames = new Map<number, FrameRequestCallback>();

function flushAnimationFrames() {
  const pending = Array.from(animationFrames.values());
  animationFrames.clear();
  for (const callback of pending) {
    callback(performance.now());
  }
}

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params: Record<string, string> = {}) =>
      (
        ({
          processingQuietNoOutput: "No new output for {silence}",
          processingQuietProviderActive:
            "No new output for {silence} · provider reports the turn active ({checked} ago)",
          processingThinkingTranscriptHide:
            "Hide thinking transcript rows (display only; the agent keeps working)",
          processingThinkingTranscriptShowHidden:
            "Show hidden thinking transcript rows",
          processingThinkingTranscriptShowWhenAvailable:
            "Show thinking transcript rows when available",
          processingThinkingRightClickShowExpandAll:
            "Right-click: show thinking and expand all blocks",
          processingThinkingRightClickExpandAll:
            "Right-click: expand all thinking blocks, including earlier ones",
          processingThinkingRightClickLatestOnly:
            "Right-click: auto-expand only the latest thinking block",
          processingAnimationPause: "Pause processing text animation",
          processingAnimationResume: "Resume processing text animation",
        }) as Record<string, string>
      )[key]?.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? "") ??
      key,
  }),
}));

function inTurnLiveness(
  fields: Partial<SessionLivenessSnapshot>,
): SessionLivenessSnapshot {
  return {
    checkedAt: new Date().toISOString(),
    derivedStatus: "verified-waiting-provider",
    activeWorkKind: "agent-turn",
    state: "in-turn",
    evidence: [],
    lastProviderMessageAt: null,
    lastRawProviderEventAt: null,
    lastRawProviderEventSource: null,
    lastStateChangeAt: new Date().toISOString(),
    lastVerifiedProgressAt: null,
    lastVerifiedIdleAt: null,
    lastLivenessProbeAt: null,
    lastLivenessProbeStatus: null,
    lastLivenessProbeSource: null,
    silenceMs: null,
    longSilenceThresholdMs: 300_000,
    queueDepth: 0,
    deferredQueueDepth: 0,
    ...fields,
  };
}

describe("ProcessingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nextAnimationFrameId = 1;
    animationFrames = new Map();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextAnimationFrameId;
        nextAnimationFrameId += 1;
        animationFrames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        animationFrames.delete(id);
      }),
    );
    // Mock localStorage for useFunPhrases hook - disable fun phrases for predictable tests
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue("false"),
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders nothing when not processing", () => {
    const { container } = render(<ProcessingIndicator isProcessing={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the activity dot without a text cursor", () => {
    render(<ProcessingIndicator isProcessing={true} />);

    expect(document.querySelector(".processing-cursor")).toBeNull();
    expect(document.querySelector("[data-processing-text]")?.textContent).toBe(
      "",
    );

    const dotContainer = document.querySelector(
      "[data-processing-dot-container]",
    );
    expect(dotContainer?.firstElementChild?.firstElementChild).not.toBeNull();
  });

  it("types text progressively over time", async () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const textElement = document.querySelector("[data-processing-text]");

    expect(textElement?.textContent).toBe("");

    // The timer only queues work; text changes on the next visual frame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(textElement?.textContent).toBe("");
    act(flushAnimationFrames);
    expect(textElement?.textContent).toBe("T");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    act(flushAnimationFrames);
    expect(textElement?.textContent).toBe("Th");
  });

  it("coalesces simultaneous animation timers into one visual frame", async () => {
    render(<ProcessingIndicator isProcessing={true} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-processing-text]")?.textContent).toBe(
      "",
    );

    act(flushAnimationFrames);
    expect(document.querySelector("[data-processing-text]")?.textContent).toBe(
      "",
    );
  });

  it("does not schedule text frames while outside the viewport", async () => {
    let notifyIntersection: IntersectionObserverCallback = () => {};
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback;
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const { container } = render(<ProcessingIndicator isProcessing={true} />);
    const indicator = container.querySelector(
      "[data-processing-indicator]",
    ) as HTMLElement;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    act(() => {
      notifyIntersection(
        [
          { target: indicator, isIntersecting: true },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      notifyIntersection(
        [
          { target: indicator, isIntersecting: false },
        ] as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
    });
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(animationFrames.size).toBe(0);
  });

  it("pauses and resumes the typewriter when clicked", async () => {
    render(<ProcessingIndicator isProcessing={true} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const toggle = screen.getByRole("button", {
      name: "Pause processing text animation",
    });
    const pausedText = toggle.textContent;
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe(
      "Resume processing text animation",
    );
    expect(document.querySelector(".processing-cursor")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(toggle.textContent).toBe(pausedText);

    fireEvent.click(toggle);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    act(flushAnimationFrames);

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).not.toBe(pausedText);
  });

  it("states the silence instead of rotating phrases once output stops", async () => {
    vi.setSystemTime(new Date("2026-10-23T20:00:00Z"));
    const liveness = inTurnLiveness({
      lastStateChangeAt: "2026-10-23T19:55:00Z",
      lastProviderMessageAt: "2026-10-23T19:57:00Z",
      lastLivenessProbeStatus: "active",
      lastLivenessProbeAt: "2026-10-23T19:59:50Z",
    });
    const indicator = (lastMessageAtMs: number) => (
      <SessionLivenessProvider value={liveness}>
        <ProcessingIndicator
          isProcessing={true}
          lastMessageAtMs={lastMessageAtMs}
        />
      </SessionLivenessProvider>
    );
    const { rerender } = render(indicator(Date.parse("2026-10-23T19:56:00Z")));

    expect(screen.getByRole("status").textContent).toBe(
      "No new output for 3m 0s · provider reports the turn active (10s ago)",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status").textContent).toBe(
      "No new output for 3m 1s · provider reports the turn active (11s ago)",
    );
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    rerender(indicator(Date.now()));
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Pause processing text animation" }),
    ).toBeDefined();
  });

  it("has processing indicator container", () => {
    render(<ProcessingIndicator isProcessing={true} />);

    const container = document.querySelector("[data-processing-indicator]");
    expect(container).not.toBeNull();

    const dotContainer = document.querySelector(
      "[data-processing-dot-container]",
    );
    expect(dotContainer).not.toBeNull();
  });

  it("can expose a compact thinking transcript visibility toggle", () => {
    const onToggle = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={false}
        onToggleThinkingItemsVisible={onToggle}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Show hidden thinking transcript rows",
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("right-clicking the toggle flips the auto-expand policy, not visibility", () => {
    const onToggleVisible = vi.fn();
    const onToggleLatestOnly = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        onToggleThinkingItemsVisible={onToggleVisible}
        onToggleThinkingLatestOnly={onToggleLatestOnly}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.contextMenu(button);

    expect(onToggleLatestOnly).toHaveBeenCalledTimes(1);
    expect(onToggleVisible).not.toHaveBeenCalled();
  });

  it("marks the toggle and hints that right-click expands history in latest-only mode", () => {
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        thinkingLatestOnly={true}
        onToggleThinkingItemsVisible={vi.fn()}
        onToggleThinkingLatestOnly={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.hasAttribute("data-is-latest-only")).toBe(true);
    expect(button.getAttribute("title")).toContain(
      "expand all thinking blocks, including earlier ones",
    );
    // The accessible name stays the clean click action.
    expect(button.getAttribute("aria-label")).toBe(
      "Hide thinking transcript rows (display only; the agent keeps working)",
    );
  });

  it("hints that right-click drops back to latest-only when everything expands", () => {
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        thinkingLatestOnly={false}
        onToggleThinkingItemsVisible={vi.fn()}
        onToggleThinkingLatestOnly={vi.fn()}
      />,
    );

    expect(screen.getByRole("button").getAttribute("title")).toContain(
      "auto-expand only the latest thinking block",
    );
  });

  it("right-click works from the hidden state and the hint says it reveals", () => {
    const onToggleLatestOnly = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={false}
        onToggleThinkingItemsVisible={vi.fn()}
        onToggleThinkingLatestOnly={onToggleLatestOnly}
      />,
    );

    const button = screen.getByRole("button");
    expect(button.getAttribute("title")).toContain(
      "show thinking and expand all blocks",
    );

    fireEvent.contextMenu(button);
    expect(onToggleLatestOnly).toHaveBeenCalledTimes(1);
  });

  it("long-press toggles policy and suppresses the follow-up click", () => {
    const onToggleVisible = vi.fn();
    const onToggleLatestOnly = vi.fn();
    render(
      <ProcessingIndicator
        isProcessing={false}
        hasThinkingItems={true}
        thinkingItemsVisible={true}
        onToggleThinkingItemsVisible={onToggleVisible}
        onToggleThinkingLatestOnly={onToggleLatestOnly}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.touchStart(button);
    act(() => {
      vi.advanceTimersByTime(450);
    });
    fireEvent.touchEnd(button);
    fireEvent.click(button);

    expect(onToggleLatestOnly).toHaveBeenCalledTimes(1);
    expect(onToggleVisible).not.toHaveBeenCalled();
  });

  it("hides when processing stops", async () => {
    const { rerender } = render(<ProcessingIndicator isProcessing={true} />);

    // Verify it's visible
    expect(
      document.querySelector("[data-processing-indicator]"),
    ).not.toBeNull();

    // Stop processing
    rerender(<ProcessingIndicator isProcessing={false} />);

    // Should render nothing
    expect(document.querySelector("[data-processing-indicator]")).toBeNull();
  });

  it("restarts when re-enabled after stopping", async () => {
    const { rerender } = render(<ProcessingIndicator isProcessing={true} />);

    // Advance some time
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Stop processing
    rerender(<ProcessingIndicator isProcessing={false} />);
    expect(document.querySelector("[data-processing-indicator]")).toBeNull();

    // Start processing again
    rerender(<ProcessingIndicator isProcessing={true} />);

    // Should be visible again without reintroducing a cursor.
    expect(
      document.querySelector("[data-processing-indicator]"),
    ).not.toBeNull();
    expect(document.querySelector(".processing-cursor")).toBeNull();
  });
});
