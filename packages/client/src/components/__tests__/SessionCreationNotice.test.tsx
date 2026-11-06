import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionCreationStatus } from "@yep-anywhere/shared";
import { I18nProvider } from "../../i18n";
import { SessionCreationNotice } from "../SessionCreationNotice";
import type {
  SourceTransportStatus,
  SourceTransportStatusSnapshot,
} from "../../lib/transport/types";

const starting: SessionCreationStatus = {
  state: "bound",
  delivery: "not-admitted",
  attemptId: "startup",
  updatedAt: "2026-11-04T00:00:00Z",
};

it("shows the specific router refusal as text alongside the saved prompt", () => {
  render(
    <SessionCreationNotice
      creation={{
        ...starting,
        state: "failed",
        failure: "router-refused",
        failureDetail:
          "no eligible pool account: quota stale; check Pools and usage",
      }}
      prompt="Saved original"
      onRefresh={async () => {}}
    />,
    { wrapper: I18nProvider },
  );
  expect(
    screen.getByText(
      "no eligible pool account: quota stale; check Pools and usage",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Saved original")).toBeTruthy();
});
let visibility: DocumentVisibilityState;
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("refreshes on a restored transport without restarting for unrelated status updates", async () => {
  let snapshot: SourceTransportStatusSnapshot = {
    kind: "localhost",
    state: "ready",
    channels: [],
  };
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const status: SourceTransportStatus = {
    getSnapshot: () => snapshot,
    subscribe: (callback) => {
      listener = callback;
      return unsubscribe;
    },
  };
  const refresh = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <SessionCreationNotice
      creation={starting}
      onRefresh={refresh}
      transportStatus={status}
    />,
    { wrapper: I18nProvider },
  );
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(refresh).toHaveBeenCalledTimes(1);
  snapshot = { ...snapshot, state: "reconnecting" };
  await act(async () => listener!());
  snapshot = { ...snapshot, state: "ready" };
  await act(async () => listener!());
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => listener!());
  expect(refresh).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(60000));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("keeps startup hidden until checks exhaust and removes recovery immediately on delivery", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { language: "en", clipboard: { writeText } });
  let delivered = false;
  const reads = vi.fn();
  function View() {
    const [creation, setCreation] = useState(starting);
    return (
      <SessionCreationNotice
        creation={creation}
        prompt="Saved original"
        onRefresh={async () => {
          reads();
          if (delivered) setCreation({ ...starting, delivery: "consumed" });
        }}
      />
    );
  }
  const { container } = render(<View />, { wrapper: I18nProvider });
  expect(container.innerHTML).toBe("");
  visibility = "hidden";
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(reads).not.toHaveBeenCalled();
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(reads).toHaveBeenCalledTimes(1);
  expect(container.innerHTML).toBe("");
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(reads).toHaveBeenCalledTimes(15);
  expect(screen.getByText("Saved original").tagName).toBe("PRE");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" })),
  );
  expect(writeText).toHaveBeenCalledWith("Saved original");
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
  delivered = true;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.innerHTML).toBe("");
  await act(() => vi.advanceTimersByTimeAsync(60000));
  expect(reads).toHaveBeenCalledTimes(16);
});

it("releases startup timers when parked and preserves recovery controls for failed delivery", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const view = (creation: SessionCreationStatus, paused = false) => (
    <SessionCreationNotice
      creation={creation}
      prompt="Saved original"
      onRefresh={refresh}
      paused={paused}
    />
  );
  const { container, rerender } = render(view(starting), {
    wrapper: I18nProvider,
  });
  rerender(view(starting, true));
  await act(() => vi.advanceTimersByTimeAsync(60000));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(refresh).not.toHaveBeenCalled();
  rerender(view({ ...starting, state: "failed", failure: "launch-refused" }));
  expect(
    screen.getByText("The session could not start. Your prompt is saved."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy prompt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
  rerender(view({ ...starting, state: "uncertain" }));
  expect(screen.getByText(/Startup was interrupted/)).toBeTruthy();
  rerender(view({ ...starting, state: "queued", attemptId: "new-attempt" }));
  expect(container.innerHTML).toBe("");
});
