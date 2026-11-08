import { describe, expect, it } from "vitest";
import {
  type ComposerDeliveryAvailability,
  type ComposerDeliveryContext,
  type ComposerDeliveryRoute,
  canDeliverOnRoute,
  planComposerDelivery,
  resolvePrimaryDeliveryRoute,
  routeTriesQuestionAside,
} from "../composerDelivery";

const available: ComposerDeliveryAvailability = {
  disabled: false,
  forkMode: false,
  forkSubmitting: false,
  forkWithoutSummary: false,
  nonTextContentCount: 0,
  canQueue: true,
  canProjectQueue: true,
  canProjectQueueNewSession: true,
};

const context: ComposerDeliveryContext = {
  attachmentCount: 0,
  uploadCount: 0,
  doneAvailable: true,
  bangAvailable: true,
  primaryActionKind: "send",
  patientQueueEnabled: false,
  topicShiftSupported: true,
  topicShiftCompactPercent: 60,
  patientQueueCompactPercent: undefined,
};

const send: ComposerDeliveryRoute = { kind: "send" };
const queue: ComposerDeliveryRoute = { kind: "queue" };
const topicShift: ComposerDeliveryRoute = { kind: "queue", topicShift: true };
const projectQueue: ComposerDeliveryRoute = {
  kind: "project-queue",
  newSession: false,
};
const projectQueueNewSession: ComposerDeliveryRoute = {
  kind: "project-queue",
  newSession: true,
};
const forkSummary: ComposerDeliveryRoute = { kind: "fork-summary" };
const forkWithoutSummary: ComposerDeliveryRoute = {
  kind: "fork-without-summary",
};

describe("resolvePrimaryDeliveryRoute", () => {
  it("forks in fork mode, queues when Queue is the main action, else sends", () => {
    expect(
      resolvePrimaryDeliveryRoute({
        forkMode: true,
        primaryActionKind: "queue",
      }),
    ).toEqual(forkSummary);
    expect(
      resolvePrimaryDeliveryRoute({
        forkMode: false,
        primaryActionKind: "queue",
      }),
    ).toEqual(queue);
    expect(
      resolvePrimaryDeliveryRoute({
        forkMode: false,
        primaryActionKind: "steer",
      }),
    ).toEqual(send);
  });
});

describe("canDeliverOnRoute", () => {
  it("refuses every route while disabled", () => {
    for (const route of [send, queue, projectQueue, forkSummary]) {
      expect(
        canDeliverOnRoute(route, {
          ...available,
          disabled: true,
          forkMode: route === forkSummary,
        }),
      ).toBe(false);
    }
  });

  it("delivers only on the fork routes in fork mode", () => {
    const forkState = {
      ...available,
      forkMode: true,
      forkWithoutSummary: true,
    };
    expect(canDeliverOnRoute(forkSummary, forkState)).toBe(true);
    expect(canDeliverOnRoute(forkWithoutSummary, forkState)).toBe(true);
    for (const route of [send, queue, topicShift, projectQueue]) {
      expect(canDeliverOnRoute(route, forkState)).toBe(false);
    }
    expect(canDeliverOnRoute(forkSummary, available)).toBe(false);
    expect(
      canDeliverOnRoute(forkWithoutSummary, {
        ...forkState,
        forkWithoutSummary: false,
      }),
    ).toBe(false);
  });

  it("refuses a fork already on its way", () => {
    expect(
      canDeliverOnRoute(forkSummary, {
        ...available,
        forkMode: true,
        forkSubmitting: true,
      }),
    ).toBe(false);
  });

  it("refuses a fork with attachments or uploads", () => {
    expect(
      canDeliverOnRoute(forkSummary, {
        ...available,
        forkMode: true,
        nonTextContentCount: 1,
      }),
    ).toBe(false);
  });

  it("needs a handler for queue and each Project Queue route", () => {
    expect(canDeliverOnRoute(queue, { ...available, canQueue: false })).toBe(
      false,
    );
    expect(
      canDeliverOnRoute(projectQueue, { ...available, canProjectQueue: false }),
    ).toBe(false);
    expect(
      canDeliverOnRoute(projectQueueNewSession, {
        ...available,
        canProjectQueue: false,
      }),
    ).toBe(true);
    expect(
      canDeliverOnRoute(projectQueueNewSession, {
        ...available,
        canProjectQueueNewSession: false,
      }),
    ).toBe(false);
  });
});

describe("routeTriesQuestionAside", () => {
  it("takes the main send and queue only", () => {
    expect(routeTriesQuestionAside(send)).toBe(true);
    expect(routeTriesQuestionAside(queue)).toBe(true);
    expect(routeTriesQuestionAside(topicShift)).toBe(true);
    expect(routeTriesQuestionAside({ kind: "send", action: "steer" })).toBe(
      false,
    );
    expect(routeTriesQuestionAside({ kind: "send", action: "send" })).toBe(
      false,
    );
    expect(routeTriesQuestionAside(projectQueue)).toBe(false);
    expect(routeTriesQuestionAside(forkSummary)).toBe(false);
  });
});

describe("planComposerDelivery", () => {
  it("resolves send's intent from its action, else the main action", () => {
    expect(planComposerDelivery(send, "hi  ", context)).toEqual({
      kind: "deliver",
      text: "hi",
      intent: "direct",
    });
    expect(
      planComposerDelivery({ kind: "send", action: "steer" }, "hi", context),
    ).toMatchObject({ intent: "steer" });
    expect(
      planComposerDelivery(send, "hi", {
        ...context,
        primaryActionKind: "queue",
      }),
    ).toMatchObject({ intent: "deferred" });
  });

  it("queues deferred, patient by default when enabled, and as a topic shift", () => {
    expect(planComposerDelivery(queue, "later", context)).toEqual({
      kind: "deliver",
      text: "later",
      intent: "deferred",
    });
    expect(
      planComposerDelivery(queue, "later", {
        ...context,
        patientQueueEnabled: true,
      }),
    ).toEqual({
      kind: "deliver",
      text: "later",
      intent: "patient",
      patientSource: "patient-default",
    });
    expect(planComposerDelivery(topicShift, "new topic", context)).toEqual({
      kind: "deliver",
      text: "new topic",
      intent: "patient",
      patientSource: "topic-shift",
      compactAboveContextPercent: 60,
    });
    // A server without topic shifts gets the patient intent alone.
    expect(
      planComposerDelivery(topicShift, "new topic", {
        ...context,
        topicShiftSupported: false,
      }),
    ).toEqual({ kind: "deliver", text: "new topic", intent: "patient" });
  });

  it("queues to the Project Queue deferred", () => {
    expect(planComposerDelivery(projectQueueNewSession, "x", context)).toEqual({
      kind: "deliver",
      text: "x",
      intent: "deferred",
    });
  });

  it("runs !! from every route but the forks, and drops the space escape", () => {
    for (const route of [send, queue, topicShift, projectQueue]) {
      expect(planComposerDelivery(route, "!!git status", context)).toEqual({
        kind: "bang",
        command: "git status",
      });
      expect(planComposerDelivery(route, " !!literal", context)).toMatchObject({
        kind: "deliver",
        text: "!!literal",
      });
    }
    expect(
      planComposerDelivery(send, "!!git status", {
        ...context,
        bangAvailable: false,
      }),
    ).toMatchObject({ kind: "deliver", text: "!!git status" });
    // The bang commands topic: a bare `!!` is a silent no-op.
    for (const route of [send, queue, projectQueue]) {
      expect(planComposerDelivery(route, "!!  ", context)).toEqual({
        kind: "ignore",
      });
    }
    expect(planComposerDelivery(forkSummary, "!!ls", context)).toEqual({
      kind: "deliver",
      text: "!!ls",
    });
  });

  it("catches /done on every route but the forks, without attachments", () => {
    for (const route of [send, queue, projectQueue]) {
      expect(planComposerDelivery(route, " /done ", context)).toEqual({
        kind: "done",
      });
    }
    expect(
      planComposerDelivery(send, "/done", { ...context, attachmentCount: 1 }),
    ).toMatchObject({ kind: "deliver", text: "/done" });
    expect(
      planComposerDelivery(send, "/done", { ...context, uploadCount: 1 }),
    ).toMatchObject({ kind: "deliver" });
    expect(
      planComposerDelivery(send, "/done", { ...context, doneAvailable: false }),
    ).toMatchObject({ kind: "deliver" });
    expect(planComposerDelivery(forkSummary, "/done", context)).toEqual({
      kind: "deliver",
      text: "/done",
    });
  });

  it("ignores an empty draft unless it carries attachments", () => {
    expect(planComposerDelivery(send, "  \n", context)).toEqual({
      kind: "ignore",
    });
    expect(
      planComposerDelivery(queue, "", { ...context, attachmentCount: 1 }),
    ).toEqual({ kind: "deliver", text: "", intent: "deferred" });
  });

  it("lets the forks deliver empty text, the no-summary turn verbatim", () => {
    expect(planComposerDelivery(forkSummary, "  focus  ", context)).toEqual({
      kind: "deliver",
      text: "focus",
    });
    expect(planComposerDelivery(forkSummary, "", context)).toEqual({
      kind: "deliver",
      text: "",
    });
    expect(
      planComposerDelivery(forkWithoutSummary, "  next turn  ", context),
    ).toEqual({ kind: "deliver", text: "  next turn  " });
  });
});
