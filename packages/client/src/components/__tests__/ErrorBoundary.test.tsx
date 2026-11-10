import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityBus } from "../../lib/activityBus";
import { ErrorBoundary, redactClientCrashUrl } from "../ErrorBoundary";

function ThrowingSessionView(): never {
  throw new Error("maximum update depth probe");
}

describe("ErrorBoundary", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    consoleError.mockClear();
    writeText.mockClear();
    vi.stubGlobal("__APP_VERSION__", "0.7.0-test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ current: "0.7.0-server" }),
      }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    localStorage.setItem("yep-anywhere-conversation-view-enabled", "true");
    localStorage.setItem("yep-anywhere-conversation-view-turn-limit", "100");
    localStorage.setItem("yep-anywhere-session-thinking-visible", "true");

    const messageRow = document.createElement("div");
    messageRow.setAttribute("data-message-render-row", "");
    document.body.append(messageRow);
    const activityRow = document.createElement("div");
    activityRow.setAttribute("data-conversation-activity-row", "");
    document.body.append(activityRow);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it.each([
    [
      "https://ya.example/share/bearer-secret?viewer=private#fragment",
      "https://ya.example/share/[redacted]",
    ],
    [
      "https://ya.example/remote/share/other-secret/file?path=private.txt",
      "https://ya.example/remote/share/[redacted]/file",
    ],
  ])("redacts public route credentials from %s", (href, expected) => {
    expect(redactClientCrashUrl(href)).toBe(expected);
  });

  it("never emits a public-share bearer URL in fatal diagnostics", async () => {
    window.history.replaceState(
      {},
      "",
      "/remote/share/fatal-secret/file?path=private.txt#viewer-state",
    );

    render(
      <ErrorBoundary>
        <ThrowingSessionView />
      </ErrorBoundary>,
    );
    await waitFor(() => expect(consoleError).toHaveBeenCalled());

    const emitted = String(consoleError.mock.calls.at(-1)?.[0]);
    expect(emitted).toContain("/remote/share/[redacted]/file");
    expect(emitted).not.toContain("fatal-secret");
    expect(emitted).not.toContain("private.txt");
    expect(emitted).not.toContain("viewer-state");
  });

  it("copies the diagnostic from its header without expanding it", async () => {
    render(
      <ErrorBoundary>
        <ThrowingSessionView />
      </ErrorBoundary>,
    );
    await screen.findByText("0.7.0-server");
    const details = screen.getByText("Diagnostic details").closest("details");
    const copy = screen.getAllByRole("button", { name: "Copy Diagnostics" })[0];
    expect(copy?.querySelector("svg")).toBeTruthy();
    fireEvent.click(copy!);
    await screen.findByText("Diagnostics Copied");
    expect(details?.open).toBe(false);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(
      details?.querySelector("pre")?.textContent,
    );
  });

  it("names the activity traffic the tab was reacting to", async () => {
    activityBus.emitLocal("refresh", undefined);

    render(
      <ErrorBoundary>
        <ThrowingSessionView />
      </ErrorBoundary>,
    );
    await waitFor(() => expect(consoleError).toHaveBeenCalled());

    const emitted = String(consoleError.mock.calls.at(-1)?.[0]);
    expect(emitted).toMatch(
      /Activity events before the crash \(newest first\): refresh \(local\) 0\.0s/,
    );
    expect(emitted).toContain("Tab: visible");
  });

  it("preserves the component stack and session render context", async () => {
    render(
      <ErrorBoundary>
        <ThrowingSessionView />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("0.7.0-server")).toBeTruthy());

    fireEvent.click(screen.getByText("Diagnostic details"));
    const diagnostic = screen.getByText(
      /Yep Anywhere client fatal error/,
    ).textContent;
    expect(diagnostic).toContain("maximum update depth probe");
    expect(diagnostic).toContain("React component stack:");
    expect(diagnostic).toContain("ThrowingSessionView");
    expect(diagnostic).toContain('"messageRows":1');
    expect(diagnostic).toContain('"conversationActivityRows":1');
    expect(diagnostic).toContain('"conversationView":"true"');

    fireEvent.click(screen.getByText("Copy Diagnostics"));
    await screen.findByText("Diagnostics Copied");
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain("ThrowingSessionView");

    const issueLink = screen.getByText("Report Issue").closest("a");
    expect(issueLink?.href).toContain(
      "github.com/kzahel/yepanywhere/issues/new?",
    );
    expect(decodeURIComponent(issueLink?.href ?? "")).toContain(
      "ThrowingSessionView",
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[ErrorBoundary] Fatal client render error"),
    );
  });
});
