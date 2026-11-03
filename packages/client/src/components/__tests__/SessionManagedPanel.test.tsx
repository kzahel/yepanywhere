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
import { I18nProvider } from "../../i18n";
import {
  clearCurrentSessionViewer,
  presentSessionViewer,
  setSessionViewerCloseAction,
  getSessionViewerSnapshot,
  subscribeSessionViewer,
  useSessionViewerController,
} from "../../lib/sessionViewerController";
import { sessionRightPaneSetting } from "../../lib/sessionViewerPlacement";
import {
  SessionManagedPanel,
  SessionViewerProvider,
} from "../SessionManagedViewer";

function Detail({ version }: { version: number }) {
  const [selection, setSelection] = useState(0);
  return (
    <button type="button" onClick={() => setSelection(selection + 1)}>
      detail {version}, selection {selection}
    </button>
  );
}

function PublishingParent({
  version,
  onAction,
  target,
}: {
  version: number;
  onAction: () => void;
  target: HTMLElement;
}) {
  // The real SessionPage subscribes through useSessionRightPane. Recreating
  // content below a controller subscriber used to close the publication loop.
  const viewer = useSessionViewerController();
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider>
      <SessionViewerProvider sessionId="panel-session" rightPaneTarget={target}>
        <button type="button" onClick={() => setOpen(true)}>
          Open details
        </button>
        <output>{viewer?.minimized ? "parked" : "unparked"}</output>
        {open && (
          <SessionManagedPanel
            viewerId="panel"
            sessionId="panel-session"
            label="Details"
            title={<span>title {version}</span>}
            actions={
              <button type="button" onClick={onAction}>
                Current action
              </button>
            }
            onClose={() => {
              onAction();
              setOpen(false);
            }}
          >
            <Detail version={version} />
          </SessionManagedPanel>
        )}
      </SessionViewerProvider>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  act(() => clearCurrentSessionViewer());
});

describe("managed panel publication below a controller subscriber", () => {
  it.each([false, true])(
    "settles and keeps content fresh with right pane %s",
    async (rightPane) => {
      sessionRightPaneSetting.set(rightPane);
      const target = document.createElement("div");
      document.body.append(target);
      const notifications = vi.fn();
      const unsubscribe = subscribeSessionViewer(notifications);
      const oldAction = vi.fn();
      const newAction = vi.fn();
      try {
        const view = render(
          <PublishingParent version={1} onAction={oldAction} target={target} />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Open details" }));
        fireEvent.click(
          screen.getByRole("button", { name: "detail 1, selection 0" }),
        );
        const metadata = getSessionViewerSnapshot();
        const settled = notifications.mock.calls.length;
        view.rerender(
          <PublishingParent version={2} onAction={newAction} target={target} />,
        );
        expect(screen.getByText("title 2")).toBeTruthy();
        expect(
          screen.getByRole("button", { name: "detail 2, selection 1" }),
        ).toBeTruthy();
        expect(getSessionViewerSnapshot()).toBe(metadata);
        expect(notifications).toHaveBeenCalledTimes(settled);
        fireEvent.click(screen.getByRole("button", { name: "Current action" }));
        expect(newAction).toHaveBeenCalledTimes(1);
        expect(oldAction).not.toHaveBeenCalled();
        act(() => getSessionViewerSnapshot()?.minimize());
        expect(screen.getByText("parked")).toBeTruthy();
        view.rerender(
          <PublishingParent version={3} onAction={newAction} target={target} />,
        );
        act(() => getSessionViewerSnapshot()?.restore());
        expect(
          screen.getByRole("button", { name: "detail 3, selection 1" }),
        ).toBeTruthy();
        act(() => getSessionViewerSnapshot()?.close());
        expect(getSessionViewerSnapshot()).toBeNull();
        await waitFor(() =>
          expect(
            screen.queryByRole("button", { name: "Current action" }),
          ).toBeNull(),
        );
        expect(newAction).toHaveBeenCalledTimes(2);
        expect(oldAction).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        target.remove();
      }
    },
  );
});

it("refreshes file rendering and opaque actions without waking metadata subscribers", () => {
  const oldAction = vi.fn();
  const newAction = vi.fn();
  const close = vi.fn();
  const notifications = vi.fn();
  const unsubscribe = subscribeSessionViewer(notifications);
  const file = (version: number) => ({
    id: "file",
    kind: "file" as const,
    sessionId: "file-session",
    label: "notes.md",
    filePath: "notes.md",
    lineSuffix: "",
    onClose: close,
    renderContent: () => <Detail version={version} />,
  });
  try {
    render(
      <I18nProvider>
        <SessionViewerProvider sessionId="file-session">
          {null}
        </SessionViewerProvider>
      </I18nProvider>,
    );
    act(() => presentSessionViewer(file(1)));
    fireEvent.click(
      screen.getByRole("button", { name: "detail 1, selection 0" }),
    );
    const metadata = getSessionViewerSnapshot();
    notifications.mockClear();
    act(() => presentSessionViewer(file(2)));
    expect(
      screen.getByRole("button", { name: "detail 2, selection 1" }),
    ).toBeTruthy();
    expect(getSessionViewerSnapshot()).toBe(metadata);
    expect(notifications).not.toHaveBeenCalled();
    act(() =>
      setSessionViewerCloseAction("file", {
        label: "sessionViewerClose",
        run: oldAction,
      }),
    );
    const actionMetadata = getSessionViewerSnapshot();
    notifications.mockClear();
    act(() =>
      setSessionViewerCloseAction("file", {
        label: "sessionViewerClose",
        run: newAction,
      }),
    );
    expect(getSessionViewerSnapshot()).toBe(actionMetadata);
    expect(notifications).not.toHaveBeenCalled();
    act(() => actionMetadata?.closeAction?.run());
    expect(newAction).toHaveBeenCalledOnce();
    expect(oldAction).not.toHaveBeenCalled();
    act(() =>
      setSessionViewerCloseAction("file", {
        label: "sessionViewerClose",
        busy: true,
        run: newAction,
      }),
    );
    expect(getSessionViewerSnapshot()?.closeAction?.busy).toBe(true);
    expect(notifications).toHaveBeenCalledOnce();
    notifications.mockClear();
    act(() => getSessionViewerSnapshot()?.restore());
    expect(notifications).not.toHaveBeenCalled();
    act(() => getSessionViewerSnapshot()?.close());
    expect(close).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
  }
});
