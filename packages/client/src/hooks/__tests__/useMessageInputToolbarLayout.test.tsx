import toolbarStyles from "../../components/MessageInputToolbar.module.css";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_TOOLBAR_PRIORITY } from "../useSessionToolbarPresence";
import { useMeasuredComposerOverflow } from "../useMessageInputToolbarLayout";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "hides only enough controls, respecting configured priority and ties (%s)",
  (samePriority) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const frame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", frame);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return { width: Number(this.dataset.width ?? 100) } as DOMRect;
      },
    );
    function Toolbar({ composing }: { composing: boolean }) {
      const { tier, hiddenControls, setToolbarRef } =
        useMeasuredComposerOverflow({
          layoutKey: String(composing),
          hasControls: true,
          priority: {
            ...DEFAULT_SESSION_TOOLBAR_PRIORITY,
            modeSelector: "first",
            attachments: samePriority ? "first" : "mid",
          },
          pinOnlyMicrophone: false,
        });
      return (
        <div
          ref={setToolbarRef}
          data-width="180"
          data-testid="toolbar"
          data-tier={tier}
        >
          <div data-message-input-left>
            <button
              type="button"
              className={toolbarStyles.composerBottomOverflowInline}
              data-session-toolbar-control="modeSelector"
              style={{
                display: hiddenControls.has("modeSelector") ? "none" : "block",
              }}
            >
              First
            </button>
            <button
              type="button"
              data-session-toolbar-control="attachments"
              className={toolbarStyles.composerBottomOverflowInline}
              style={{
                display: hiddenControls.has("attachments") ? "none" : "block",
              }}
            >
              Second
            </button>
          </div>
          <div data-message-input-actions>
            <button
              type="button"
              data-width="20"
              className={toolbarStyles.composerBottomOverflowInline}
              data-session-toolbar-control="microphone"
            >
              Pinned
            </button>
            <button type="button" data-width={composing ? 100 : 30}>
              Send
            </button>
          </div>
        </div>
      );
    }
    const { rerender } = render(<Toolbar composing={false} />);
    expect(screen.getByTestId("toolbar").dataset.tier).toBe("early");
    expect(screen.getByText("First").style.display).toBe(
      samePriority ? "block" : "none",
    );
    expect(screen.getByText("Second").style.display).toBe(
      samePriority ? "none" : "block",
    );
    rerender(<Toolbar composing />);
    expect(screen.getByTestId("toolbar").dataset.tier).toBe(
      samePriority ? "early" : "medium",
    );
    expect(screen.getByText("First").style.display).toBe("none");
    expect(screen.getByText("Second").style.display).toBe("none");
    expect(screen.getByText("Pinned").style.display).not.toBe("none");
    expect(frame).not.toHaveBeenCalled();
  },
);
