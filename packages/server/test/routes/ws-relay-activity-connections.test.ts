import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupSubscriptions,
  createConnectionState,
  handleActivitySubscribe,
  handleSubscribe,
  type SendFn,
} from "../../src/routes/ws-relay-handlers.js";
import { ConnectedBrowsersService } from "../../src/services/ConnectedBrowsersService.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("WebSocket activity browser-tab tracking", () => {
  let eventBus: EventBus;
  let connectedBrowsers: ConnectedBrowsersService;

  beforeEach(() => {
    eventBus = new EventBus();
    connectedBrowsers = new ConnectedBrowsersService(eventBus);
  });

  it("counts one socket once when it has overlapping activity streams", () => {
    const subscriptions = new Map<string, () => void>();
    const connState = createConnectionState();
    const send = vi.fn();

    for (const subscriptionId of ["activity-1", "activity-2"]) {
      handleActivitySubscribe(
        subscriptions,
        {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
          browserProfileId: "profile-1",
        },
        send,
        eventBus,
        connState,
        connectedBrowsers,
      );
    }

    expect(connectedBrowsers.getTabCount("profile-1")).toBe(1);
    expect(connectedBrowsers.getTotalTabCount()).toBe(1);

    subscriptions.get("activity-1")?.();
    expect(connectedBrowsers.getTabCount("profile-1")).toBe(1);

    cleanupSubscriptions(subscriptions);
    expect(connectedBrowsers.getTabCount("profile-1")).toBe(0);
    expect(connectedBrowsers.getTotalTabCount()).toBe(0);
    expect(eventBus.subscriberCount).toBe(0);
  });

  it("does not acquire provider ownership for an activity stream", () => {
    const subscriptions = new Map<string, () => void>();
    const supervisor = new Proxy(
      {},
      {
        get() {
          throw new Error("activity subscription accessed Supervisor");
        },
      },
    ) as Supervisor;

    handleSubscribe(
      subscriptions,
      {
        type: "subscribe",
        subscriptionId: "activity-1",
        channel: "activity",
      },
      vi.fn<SendFn>(),
      supervisor,
      undefined,
      eventBus,
      createConnectionState(),
    );

    expect(eventBus.subscriberCount).toBe(1);
    cleanupSubscriptions(subscriptions);
    expect(eventBus.subscriberCount).toBe(0);
  });
});
