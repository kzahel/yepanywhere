// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  installMessageListTestEnvironment,
  assistantMessage,
  stubClipboardWriteText,
  userMessage,
} from "./MessageList.test-support";
import { createComposerEditAvailabilityStore } from "../../lib/composerDraftSignal";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

describe("MessageList queue rows", () => {
  it("exposes a cancel control for queued messages", () => {
    const onCancelDeferred = vi.fn();

    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "queued text",
            timestamp: "2026-04-25T00:00:00.000Z",
          },
        ]}
        onCancelDeferred={onCancelDeferred}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel queued message" }),
    );

    expect(onCancelDeferred).toHaveBeenCalledWith("temp-queued");
  });

  it("renders queued /archive through the shared done lane without provider-queue actions", () => {
    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "ya-done-queued",
            content: "/archive",
            timestamp: "2026-08-16T10:00:00.000Z",
            kind: "ya-command",
            yaCommand: "done",
            status: "queued",
          },
        ]}
        onCancelDeferred={vi.fn()}
        onEditDeferred={vi.fn()}
        onSteerDeferred={vi.fn()}
      />,
    );

    expect(screen.getByText("/archive")).toBeTruthy();
    expect(screen.getByText("Queued (after current turn)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit queued message" })).toBe(
      null,
    );
    expect(
      screen.queryByRole("button", { name: "Cancel queued message" }),
    ).toBe(null);
    expect(screen.queryByText("Steer now")).toBe(null);
  });

  it("offers take-to-composer editing only while the composer is blank", () => {
    const onEditDeferred = vi.fn();
    const composerEditAvailabilityStore = createComposerEditAvailabilityStore();
    composerEditAvailabilityStore.setDraftText("   ");
    const deferredMessages = [
      {
        tempId: "temp-queued",
        content: "queued text",
        timestamp: "2026-04-25T00:00:00.000Z",
      },
    ];
    render(
      <MessageList
        messages={[]}
        composerEditAvailabilityStore={composerEditAvailabilityStore}
        deferredMessages={deferredMessages}
        onEditDeferred={onEditDeferred}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    expect(onEditDeferred).toHaveBeenCalledWith("temp-queued");

    act(() => {
      composerEditAvailabilityStore.setDraftText("existing draft");
    });
    expect(screen.queryByRole("button", { name: "Edit queued message" })).toBe(
      null,
    );
  });

  it("copies sent user message text", async () => {
    const writeText = stubClipboardWriteText();

    render(<MessageList messages={[userMessage("user-1", "sent text")]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy message text" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("sent text"));
  });

  it("exposes a cancel control for unconfirmed steering sends", () => {
    const onCancelUnconfirmedUserMessage = vi.fn();
    const steeringEcho = {
      ...userMessage("steer-echo", "steer text"),
      tempId: "temp-steer",
      _source: "sdk",
      messageMetadata: { deliveryIntent: "steer" },
    } as const;

    render(
      <MessageList
        messages={[steeringEcho]}
        onCancelUnconfirmedUserMessage={onCancelUnconfirmedUserMessage}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel sent steering message",
      }),
    );

    expect(onCancelUnconfirmedUserMessage).toHaveBeenCalledWith("temp-steer");
  });

  it("copies queued message text", async () => {
    const writeText = stubClipboardWriteText();

    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "queued text",
            timestamp: "2026-04-25T00:00:00.000Z",
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy queued message" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("queued text"));
  });

  it("renders pending sends before server-queued deferred messages", () => {
    const { container } = render(
      <MessageList
        messages={[]}
        pendingMessages={[
          {
            tempId: "temp-pending",
            content: "still posting",
            timestamp: "2026-04-25T00:00:00.000Z",
            clientOrder: 2,
          },
        ]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "already queued",
            timestamp: "2026-04-25T00:00:10.000Z",
          },
        ]}
      />,
    );

    const prompts = Array.from(
      container.querySelectorAll("[data-message-user-prompt]"),
    ).map((node) => node.textContent);
    expect(prompts).toEqual(["still posting", "already queued"]);
  });

  it("renders deferred messages in the server's queue order with status-only patient distinction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T00:03:00.000Z"));

    const { container } = render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-regular-first",
            content: "regular first",
            timestamp: "2026-04-25T00:00:01.000Z",
          },
          {
            tempId: "temp-patient",
            content: "patient second",
            timestamp: "2026-04-25T00:00:00.000Z",
            metadata: { deliveryIntent: "patient" },
          },
          {
            tempId: "temp-regular-third",
            content: "regular third",
            timestamp: "2026-04-25T00:00:02.000Z",
          },
        ]}
      />,
    );

    const prompts = Array.from(
      container.querySelectorAll("[data-message-user-prompt]"),
    ).map((node) => node.textContent);
    expect(prompts).toEqual([
      "regular first",
      "patient second",
      "regular third",
    ]);
    expect(screen.getByText("Patient (waiting, 3m ago)")).toBeTruthy();
    expect(screen.getByText("Queued (next regular)")).toBeTruthy();
    expect(screen.getByText("Queued regular (#2)")).toBeTruthy();
  });

  it("offers steer-now only on live patient chips, labeled with earlier patient count", () => {
    const onSteerDeferred = vi.fn();
    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            tempId: "temp-regular",
            content: "regular first",
            timestamp: "2026-04-25T00:00:00.000Z",
          },
          {
            tempId: "temp-patient-1",
            content: "patient one",
            timestamp: "2026-04-25T00:00:01.000Z",
            metadata: { deliveryIntent: "patient" },
          },
          {
            tempId: "temp-patient-2",
            content: "patient two",
            timestamp: "2026-04-25T00:00:02.000Z",
            metadata: { deliveryIntent: "patient" },
          },
        ]}
        onSteerDeferred={onSteerDeferred}
      />,
    );

    // Only the two patient rows carry the action; the regular row does not.
    expect(screen.getAllByText("Steer now")).toHaveLength(2);
    expect(screen.getByLabelText("Steer queued message now")).toBeTruthy();

    fireEvent.click(
      screen.getByLabelText("Steer this and 1 earlier patient message now"),
    );
    expect(onSteerDeferred).toHaveBeenCalledWith("temp-patient-2");
  });

  it("offers steer-now on restart-recovered patient chips by durable queue id", () => {
    const onSteerDeferred = vi.fn();
    const onSteerRecoveredDeferred = vi.fn();
    render(
      <MessageList
        messages={[]}
        deferredMessages={[
          {
            id: "queue-1",
            tempId: "temp-recovered-1",
            content: "recovered one",
            timestamp: "2026-04-25T00:00:00.000Z",
            status: "paused-after-restart",
            metadata: { deliveryIntent: "patient" },
          },
          {
            id: "queue-2",
            tempId: "temp-recovered-2",
            content: "recovered two",
            timestamp: "2026-04-25T00:00:01.000Z",
            status: "paused-after-restart",
            metadata: { deliveryIntent: "patient" },
          },
        ]}
        onSteerDeferred={onSteerDeferred}
        onSteerRecoveredDeferred={onSteerRecoveredDeferred}
      />,
    );

    expect(screen.getAllByText("Steer now")).toHaveLength(2);
    fireEvent.click(
      screen.getByLabelText("Steer this and 1 earlier patient message now"),
    );
    expect(onSteerRecoveredDeferred).toHaveBeenCalledWith("queue-2");
    expect(onSteerDeferred).not.toHaveBeenCalled();
  });

  it("renders project queue messages below normal queued messages with project position", () => {
    const { container } = render(
      <MessageList
        messages={[]}
        pendingMessages={[
          {
            tempId: "temp-pending",
            content: "still posting",
            timestamp: "2026-04-25T00:00:00.000Z",
            clientOrder: 2,
          },
        ]}
        deferredMessages={[
          {
            tempId: "temp-queued",
            content: "already queued",
            timestamp: "2026-04-25T00:00:10.000Z",
          },
        ]}
        projectQueueMessages={[
          {
            id: "project-queue-2",
            content: "project queued",
            timestamp: "2026-04-25T00:00:05.000Z",
            status: "queued",
            projectPosition: 2,
          },
        ]}
      />,
    );

    const prompts = Array.from(
      container.querySelectorAll("[data-message-user-prompt]"),
    ).map((node) => node.textContent);
    expect(prompts).toEqual([
      "still posting",
      "already queued",
      "project queued",
    ]);
    expect(screen.getByText("Project Queue (#2)")).toBeTruthy();
  });

  it("cancels inline project queue messages", () => {
    const onCancelProjectQueueMessage = vi.fn();
    render(
      <MessageList
        messages={[]}
        projectQueueMessages={[
          {
            id: "project-queue-1",
            content: "project queued",
            timestamp: "2026-04-25T00:00:05.000Z",
            status: "queued",
            projectPosition: 1,
          },
        ]}
        onCancelProjectQueueMessage={onCancelProjectQueueMessage}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel Project Queue item" }),
    );

    expect(onCancelProjectQueueMessage).toHaveBeenCalledWith("project-queue-1");
  });

  it("shares edit and steer actions with inline Project Queue messages", () => {
    const onEditProjectQueueMessage = vi.fn();
    const onSteerProjectQueueMessage = vi.fn();
    render(
      <MessageList
        messages={[]}
        projectQueueMessages={[
          {
            id: "project-queue-1",
            content: "project queued",
            timestamp: "2026-04-25T00:00:05.000Z",
            status: "queued",
            projectPosition: 1,
          },
        ]}
        onEditProjectQueueMessage={onEditProjectQueueMessage}
        onSteerProjectQueueMessage={onSteerProjectQueueMessage}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Project Queue item" }),
    );
    expect(onEditProjectQueueMessage).toHaveBeenCalledWith("project-queue-1");

    fireEvent.click(
      screen.getByRole("button", { name: "Steer Project Queue item now" }),
    );
    expect(onSteerProjectQueueMessage).toHaveBeenCalledWith("project-queue-1");
  });

  it("offers global resume on a paused inline Project Queue message", () => {
    const onResumeProjectQueueDispatch = vi.fn();
    render(
      <MessageList
        messages={[]}
        projectQueueMessages={[
          {
            id: "project-queue-1",
            content: "project queued",
            timestamp: "2026-04-25T00:00:05.000Z",
            status: "queued",
            projectPosition: 1,
          },
        ]}
        projectQueueDispatchPaused
        onResumeProjectQueueDispatch={onResumeProjectQueueDispatch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(onResumeProjectQueueDispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest stale message age visible in the right rail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:10:00.000Z"));
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "stale request", "2026-04-26T12:00:00.000Z"),
        ]}
      />,
    );

    const row = container.querySelector('[data-render-id="user-1"]');

    expect(row?.hasAttribute("data-has-message-age")).toBe(true);
    expect(row?.hasAttribute("data-is-message-age-visible")).toBe(true);
    expect(row?.querySelector("[data-message-age]")?.textContent).toBe("10m");
  });

  it("does not refresh historical message ages on idle ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T12:10:00.000Z"));
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "older request", "2026-04-26T12:00:00.000Z"),
          assistantMessage(
            "assistant-1",
            "latest response",
            "2026-04-26T12:04:45.000Z",
          ),
        ]}
      />,
    );

    const olderAge = container.querySelector(
      '[data-render-id="user-1"] [data-message-age]',
    );
    const latestAge = container.querySelector(
      '[data-render-id="assistant-1"] [data-message-age]',
    );

    expect(olderAge?.textContent).toBe("10m");
    expect(latestAge?.textContent).toBe("5m");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(olderAge?.textContent).toBe("10m");
    expect(latestAge?.textContent).toBe("6m");
  });
});
