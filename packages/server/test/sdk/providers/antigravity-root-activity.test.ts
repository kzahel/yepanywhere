import { expect, it } from "vitest";
import { AntigravityRootActivity } from "../../../src/sdk/providers/antigravity-root-activity.js";

it("requires a fresh fully idle summary after the most recent detached wake", () => {
  const root = new AntigravityRootActivity();
  const idle = {
    conversationId: "owned-root",
    isChild: false,
    status: "CASCADE_RUN_STATUS_IDLE",
    notFullyIdle: false,
    lastModifiedMs: 200,
  };
  root.expectReply(new Date(300));
  expect(root.snapshot?.status).toBe("unverified");
  expect(root.reconcile(undefined)).toBe(false);
  expect(root.reconcile(idle)).toBe(false);
  expect(root.observe({ sessionUpdate: "agent_message_chunk" })).toBe(true);
  expect(root.snapshot?.status).toBe("progressing");
  expect(
    root.reconcile({ ...idle, lastModifiedMs: 350, notFullyIdle: true }),
  ).toBe(false);
  expect(
    root.reconcile({ ...idle, lastModifiedMs: 350, notFullyIdle: undefined }),
  ).toBe(false);

  // A second wake can arrive before the first summary catches up.
  root.expectReply(new Date(400));
  expect(root.reconcile({ ...idle, lastModifiedMs: 350 })).toBe(false);
  expect(root.reconcile({ ...idle, lastModifiedMs: 450 }, new Date(500))).toBe(
    true,
  );
  expect(root.snapshot).toEqual({ status: "settled", at: new Date(500) });
});

it("uses a delayed child settlement timestamp before the first received ACP reply", () => {
  const root = new AntigravityRootActivity();
  root.observe({ sessionUpdate: "agent_message_chunk" }, new Date(350));
  // On a quick wake the provider can publish its final text and mark the
  // native conversation before YA observes either the content or child edge.
  root.expectReply(new Date(300));
  expect(
    root.reconcile({
      conversationId: "owned-root",
      isChild: false,
      status: "CASCADE_RUN_STATUS_IDLE",
      notFullyIdle: false,
      lastModifiedMs: 340,
    }),
  ).toBe(true);
});

it("allows a later successful foreground prompt to anchor an untracked reply", () => {
  const root = new AntigravityRootActivity();
  root.observe({ sessionUpdate: "agent_message_chunk" }, new Date(350));
  const idle = {
    conversationId: "owned-root",
    isChild: false,
    status: "CASCADE_RUN_STATUS_IDLE",
    notFullyIdle: false,
    lastModifiedMs: 340,
  };
  expect(root.reconcile(idle)).toBe(false);
  root.observeForegroundSettlement(new Date(400));
  expect(root.reconcile({ ...idle, lastModifiedMs: 360 })).toBe(false);
  expect(root.reconcile({ ...idle, lastModifiedMs: 410 })).toBe(true);
});
