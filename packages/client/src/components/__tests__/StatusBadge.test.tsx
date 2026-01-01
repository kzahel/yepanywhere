import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStatusBadge } from "../StatusBadge";

describe("SessionStatusBadge", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows Thinking badge when processState is running", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          state: "owned",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        processState="running"
      />,
    );

    const badge = container.querySelector(".status-badge.status-running");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Thinking");
  });

  it("shows nothing when owned but not running", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          state: "owned",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
      />,
    );

    // No indicator for owned sessions - "Thinking" badge shows when actually running
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("shows nothing when idle", () => {
    const { container } = render(
      <SessionStatusBadge status={{ state: "idle" }} />,
    );

    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("prioritizes needs-input over running", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          state: "owned",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        processState="running"
        pendingInputType="tool-approval"
      />,
    );

    const badge = container.querySelector(
      ".status-badge.notification-needs-input",
    );
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Approval Needed");

    const thinkingBadge = container.querySelector(".status-running");
    expect(thinkingBadge).toBeNull();
  });

  it("shows Thinking badge even when hasUnread is true", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          state: "owned",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        processState="running"
        hasUnread={true}
      />,
    );

    const thinkingBadge = container.querySelector(".status-running");
    expect(thinkingBadge).not.toBeNull();
    expect(thinkingBadge?.textContent).toBe("Thinking");
  });

  it("shows nothing for idle sessions (unread handled via CSS class)", () => {
    const { container } = render(
      <SessionStatusBadge status={{ state: "idle" }} hasUnread={true} />,
    );

    // No badge - unread is now handled via CSS class on parent element
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });

  it("shows nothing for owned sessions with unread (unread handled via CSS class)", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          state: "owned",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        hasUnread={true}
      />,
    );

    // No badge or indicator - unread is handled via CSS class on parent
    expect(container.querySelector(".status-badge")).toBeNull();
    expect(container.querySelector(".status-indicator")).toBeNull();
  });
});
