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

  it("shows green outline when owned but not running", () => {
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

    const indicator = container.querySelector(".status-indicator.status-active");
    expect(indicator).not.toBeNull();
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

    const badge = container.querySelector(".status-badge.notification-needs-input");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Approval Needed");

    const thinkingBadge = container.querySelector(".status-running");
    expect(thinkingBadge).toBeNull();
  });

  it("prioritizes running over unread", () => {
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

    const unreadBadge = container.querySelector(".notification-unread");
    expect(unreadBadge).toBeNull();
  });

  it("shows unread badge for idle sessions with unread content", () => {
    const { container } = render(
      <SessionStatusBadge status={{ state: "idle" }} hasUnread={true} />,
    );

    const unreadBadge = container.querySelector(".notification-unread");
    expect(unreadBadge).not.toBeNull();
    expect(unreadBadge?.textContent).toBe("New");
  });

  it("shows unread badge for owned sessions with unread content (not running)", () => {
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

    const unreadBadge = container.querySelector(".notification-unread");
    expect(unreadBadge).not.toBeNull();
    expect(unreadBadge?.textContent).toBe("New");

    // Should not show the green dot when unread is shown
    const indicator = container.querySelector(".status-indicator.status-active");
    expect(indicator).toBeNull();
  });
});
