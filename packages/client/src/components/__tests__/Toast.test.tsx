// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider, useToastContext } from "../../contexts/ToastContext";
import { I18nProvider } from "../../i18n";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderToasts(undo = vi.fn()) {
  function Triggers() {
    const { showToast } = useToastContext();
    return (
      <>
        <button type="button" onClick={() => showToast("Renamed", "success")}>
          Rename
        </button>
        <button type="button" onClick={() => showToast("Queued")}>
          Queue
        </button>
        <button
          type="button"
          onClick={() => showToast("Readable error", "error")}
        >
          Show error
        </button>
        <button
          type="button"
          onClick={() =>
            showToast("Archived", "success", { label: "Undo", onClick: undo })
          }
        >
          Archive
        </button>
      </>
    );
  }

  render(
    <I18nProvider>
      <ToastProvider>
        <Triggers />
      </ToastProvider>
    </I18nProvider>,
  );
}

const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("replaces the routine message in the same polite status and restarts its lifetime", () => {
  vi.useFakeTimers();
  renderToasts();
  const status = screen.getByRole("status");

  click("Rename");
  expect(status.textContent).toBe("Renamed");
  advance(2500);
  click("Queue");
  expect(screen.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Queued");
  advance(2999);
  expect(status.textContent).toBe("Queued");
  advance(1);
  expect(status.textContent).toBe("");
});

it("keeps errors and actions ahead of routine messages with independent lifetimes", () => {
  vi.useFakeTimers();
  renderToasts();

  click("Rename");
  click("Archive");
  click("Show error");
  click("Queue");

  const alerts = screen.getAllByRole("alert");
  expect(alerts.map((alert) => alert.textContent)).toEqual([
    "Archived",
    "Readable error",
  ]);
  const error = alerts[1]!;
  expect(screen.getByRole("status").textContent).toBe("Queued");
  expect(
    error.compareDocumentPosition(screen.getByText("Queued")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  advance(6999);
  expect(screen.queryByText("Queued")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();
  advance(1);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  advance(4999);
  expect(screen.queryByRole("alert")).toBe(error);
  advance(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("runs an action once and allows explicit dismissal", () => {
  const undo = vi.fn();
  renderToasts(undo);

  click("Archive");
  click("Undo");
  expect(undo).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Archived")).toBeNull();
  click("Show error");
  click("Dismiss notification");
  expect(screen.queryByRole("alert")).toBeNull();
});
