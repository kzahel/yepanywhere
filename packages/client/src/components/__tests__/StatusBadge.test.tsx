import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveCountBadge, SessionStatusBadge } from "../StatusBadge";

describe("SessionStatusBadge", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows Thinking badge when activity is in-turn", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
      />,
    );

    const badge = container.querySelector("span");
    expect(badge?.textContent).toBe("Thinking");
    expect(badge?.firstElementChild).not.toBeNull();
  });

  it("shows nothing when owned but not in-turn", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
      />,
    );

    // No indicator for owned sessions - "Thinking" badge shows when actually in-turn
    expect(container.textContent).toBe("");
  });

  it("shows nothing when unowned", () => {
    const { container } = render(
      <SessionStatusBadge status={{ owner: "none" }} />,
    );

    expect(container.textContent).toBe("");
  });

  it("prioritizes needs-input over in-turn", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
        pendingInputType="tool-approval"
      />,
    );

    expect(screen.getByText("Approval Needed")).toBeTruthy();

    expect(container.textContent).not.toContain("Thinking");
  });

  it("shows Thinking badge even when hasUnread is true", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        activity="in-turn"
        hasUnread={true}
      />,
    );

    const badge = container.querySelector("span");
    expect(badge?.textContent).toBe("Thinking");
    expect(badge?.firstElementChild).not.toBeNull();
  });

  it("shows nothing for unowned sessions (unread handled via CSS class)", () => {
    const { container } = render(
      <SessionStatusBadge status={{ owner: "none" }} hasUnread={true} />,
    );

    // No badge - unread is now handled via CSS class on parent element
    expect(container.textContent).toBe("");
  });

  it("shows nothing for owned sessions with unread (unread handled via CSS class)", () => {
    const { container } = render(
      <SessionStatusBadge
        status={{
          owner: "self",
          processId: "p1",
          permissionMode: "default",
          modeVersion: 0,
        }}
        hasUnread={true}
      />,
    );

    // No badge or indicator - unread is handled via CSS class on parent
    expect(container.textContent).toBe("");
  });

  it("labels self count badges as active", () => {
    const { container } = render(<ActiveCountBadge variant="self" count={2} />);

    expect(container.textContent).toBe("2 Active");
  });
});
