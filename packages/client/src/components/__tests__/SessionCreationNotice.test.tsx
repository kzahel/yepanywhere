import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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

it("resumes bounded metadata checks after hiding and keeps ordinary startup compact", async () => {
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
  render(<View />, { wrapper: I18nProvider });
  expect(screen.getByText("Starting session…")).toBeTruthy();
  expect(screen.queryByText("Saved prompt")).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh status" })).toBeNull();
  visibility = "hidden";
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(reads).not.toHaveBeenCalled();
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(reads).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(reads).toHaveBeenCalledTimes(15);
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
  delivered = true;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.queryByText("Starting session…")).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh status" })).toBeNull();
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
  const { rerender } = render(view(starting), { wrapper: I18nProvider });
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
});
