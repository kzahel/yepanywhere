import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../i18n";
import {
  clearCurrentSessionViewer,
  useSessionViewerController,
} from "../../lib/sessionViewerController";
import { ActivityDetailModal } from "../ActivityDetailModal";
import { SessionViewerProvider } from "../SessionManagedViewer";

function ViewerControllerProbe() {
  const viewer = useSessionViewerController();
  if (!viewer) return null;
  return (
    <>
      <button type="button" onClick={viewer.restore}>
        Restore managed viewer
      </button>
      <button type="button" onClick={viewer.close}>
        Close managed viewer
      </button>
    </>
  );
}

function StatefulContent() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Detail count {count}
    </button>
  );
}

function SessionHarness() {
  const [sourceMounted, setSourceMounted] = useState(true);
  const [open, setOpen] = useState(true);
  return (
    <I18nProvider>
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/workspace"
        sessionId="session-1"
      >
        <SessionViewerProvider sessionId="session-1">
          <button type="button" onClick={() => setSourceMounted(false)}>
            Unmount source row
          </button>
          {sourceMounted && open && (
            <ActivityDetailModal
              title="Bash Command"
              actions={<button type="button">Copy detail path</button>}
              label="Bash Command"
              onClose={() => setOpen(false)}
            >
              <StatefulContent />
            </ActivityDetailModal>
          )}
          <ViewerControllerProbe />
        </SessionViewerProvider>
      </SessionMetadataProvider>
    </I18nProvider>
  );
}

describe("ActivityDetailModal", () => {
  afterEach(() => {
    act(() => clearCurrentSessionViewer());
    document.getSelection()?.removeAllRanges();
    cleanup();
  });

  it("renders header actions without a session viewer host", () => {
    render(
      <I18nProvider>
        <ActivityDetailModal
          title="File detail"
          actions={<button type="button">Copy file path</button>}
          label="File detail"
          onClose={() => {}}
        >
          File content
        </ActivityDetailModal>
      </I18nProvider>,
    );

    expect(
      screen
        .getByRole("button", { name: "Copy file path" })
        .closest("[data-modal-header-actions]"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Select all" })
        .closest("[data-modal-header-actions]"),
    ).not.toBeNull();
  });

  it("selects the detail body from its toolbar or Ctrl+A", () => {
    const onSelectionChange = vi.fn();
    document.addEventListener("selectionchange", onSelectionChange);
    render(
      <I18nProvider>
        <ActivityDetailModal
          title="Run output"
          label="Run output"
          onClose={() => {}}
        >
          <p>Selectable run output</p>
        </ActivityDetailModal>
      </I18nProvider>,
    );

    const selectAll = screen.getByRole("button", { name: "Select all" });
    fireEvent.click(selectAll);
    expect(document.getSelection()?.toString()).toBe("Selectable run output");
    expect(onSelectionChange).toHaveBeenCalledTimes(1);

    document.getSelection()?.removeAllRanges();
    selectAll.focus();
    expect(fireEvent.keyDown(selectAll, { key: "a", ctrlKey: true })).toBe(
      false,
    );
    expect(document.getSelection()?.toString()).toBe("Selectable run output");

    document.removeEventListener("selectionchange", onSelectionChange);
  });

  it("keeps one mounted detail subtree across parking and source removal", async () => {
    render(<SessionHarness />);

    expect(
      (await screen.findByRole("button", { name: "Copy detail path" })).closest(
        "[data-modal-header-actions]",
      ),
    ).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
    expect(document.getSelection()?.toString()).toBe("Detail count 0");
    document.getSelection()?.removeAllRanges();
    fireEvent.click(
      await screen.findByRole("button", { name: "Detail count 0" }),
    );
    expect(screen.getByRole("button", { name: "Detail count 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unmount source row" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore managed viewer" }),
    );

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detail count 1" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy detail path" }),
    ).toBeTruthy();
  });

  it("preserves a detail selection while its source rerenders", async () => {
    function RerenderHarness() {
      const [activity, setActivity] = useState(0);
      return (
        <I18nProvider>
          <SessionMetadataProvider
            projectId="project-1"
            projectPath="/workspace"
            sessionId="session-1"
          >
            <SessionViewerProvider sessionId="session-1">
              <ActivityDetailModal
                title="Bash Command"
                label="Bash Command"
                onClose={() => {}}
              >
                <pre>{`first line\nactivity detail ${activity}`}</pre>
              </ActivityDetailModal>
              <button
                type="button"
                onClick={() => setActivity((value) => value + 1)}
              >
                Activity {activity}
              </button>
            </SessionViewerProvider>
          </SessionMetadataProvider>
        </I18nProvider>
      );
    }

    render(<RerenderHarness />);
    const detail = await screen.findByText(/first line/);
    const detailText = detail.firstChild;
    expect(detailText).toBeTruthy();
    if (!detailText) throw new Error("Activity detail text is missing");
    const range = document.createRange();
    range.setStart(detailText, "first line\n".length);
    range.setEnd(detailText, "first line\nactivity".length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    fireEvent.click(screen.getByRole("button", { name: "Activity 0" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Activity 1" })).toBeTruthy(),
    );

    expect(detail.firstChild).toBe(detailText);
    expect(detail.textContent).toBe("first line\nactivity detail 0");
    expect(document.getSelection()?.toString()).toBe("activity");
  });

  it("does not let a retained session host clear another session's detail", async () => {
    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/workspace"
          sessionId="session-1"
        >
          <SessionViewerProvider sessionId="session-1">
            <ActivityDetailModal
              title="Active session detail"
              label="Active session detail"
              onClose={() => {}}
            >
              Active session content
            </ActivityDetailModal>
          </SessionViewerProvider>
          <SessionViewerProvider sessionId="session-2" inactive>
            Parked session content
          </SessionViewerProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Active session content")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Active session content")).toBeTruthy();
  });

  it("dismisses the previous source when another activity replaces it", async () => {
    function ReplacementHarness() {
      const [firstOpen, setFirstOpen] = useState(true);
      const [secondOpen, setSecondOpen] = useState(false);
      return (
        <I18nProvider>
          <SessionMetadataProvider
            projectId="project-1"
            projectPath="/workspace"
            sessionId="session-1"
          >
            <SessionViewerProvider sessionId="session-1">
              <button type="button" onClick={() => setSecondOpen(true)}>
                Open second
              </button>
              {!firstOpen && <span>First dismissed</span>}
              {firstOpen && (
                <ActivityDetailModal
                  title="First activity"
                  label="First activity"
                  onClose={() => setFirstOpen(false)}
                >
                  First content
                </ActivityDetailModal>
              )}
              {secondOpen && (
                <ActivityDetailModal
                  title="Second activity"
                  label="Second activity"
                  onClose={() => setSecondOpen(false)}
                >
                  Second content
                </ActivityDetailModal>
              )}
            </SessionViewerProvider>
          </SessionMetadataProvider>
        </I18nProvider>
      );
    }

    render(<ReplacementHarness />);
    expect(await screen.findByText("First content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open second" }));

    await waitFor(() =>
      expect(screen.getByText("First dismissed")).toBeTruthy(),
    );
    expect(screen.queryByText("First content")).toBeNull();
    expect(screen.getByText("Second content")).toBeTruthy();
  });
});
