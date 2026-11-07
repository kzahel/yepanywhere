import { describe, expect, it } from "vitest";
import { buildCorrectionText } from "../correctionText";
import {
  CLAUDE_HANDOFF_REQUIRED_MESSAGE,
  type ComposerSubmissionContext,
  finalFailureNotice,
  firstSendFailureStep,
  planProjectQueue,
  planQueue,
  planSend,
  projectQueueQueuedMessage,
  resolveComposerSubmission,
  resolveProjectQueueCommand,
  shouldRetryWithResume,
} from "../sessionComposerSendDecisions";

const context = (
  overrides: Partial<ComposerSubmissionContext> = {},
): ComposerSubmissionContext => ({
  correctionOriginalText: null,
  rewindSupported: true,
  manualCompactSupported: true,
  queuedCompactionSupported: true,
  syntheticDoneEnabled: true,
  syntheticDoneSupported: true,
  syntheticArchiveSupported: true,
  syntheticTerminateSupported: true,
  fileViewCommandSupported: true,
  btwAsidesSupported: true,
  turnEffortSupported: true,
  attachmentCount: 0,
  pendingUploadCount: 0,
  t: (key) => `t:${key}`,
  ...overrides,
});

describe("resolveComposerSubmission", () => {
  it("submits an ordinary message with its slash turn fields", () => {
    expect(
      resolveComposerSubmission("Fix the build", false, context()),
    ).toEqual({
      kind: "submit",
      prepared: {
        outgoingText: "Fix the build",
        thinking: undefined,
        slashCommand: undefined,
        turnEffort: undefined,
      },
    });
  });

  it("drops a message with no content and no attachments, silently", () => {
    expect(resolveComposerSubmission("   ", false, context())).toEqual({
      kind: "drop",
    });
    expect(
      resolveComposerSubmission("   ", false, context({ attachmentCount: 1 })),
    ).toMatchObject({ kind: "submit" });
    // A pending upload alone does not count as content.
    expect(
      resolveComposerSubmission(
        "   ",
        false,
        context({ pendingUploadCount: 1 }),
      ),
    ).toEqual({ kind: "drop" });
  });

  it("strips a turn-effort command and refuses it, raw text restored, when unsupported", () => {
    expect(
      resolveComposerSubmission("/fast tidy the imports", false, context()),
    ).toMatchObject({
      kind: "submit",
      prepared: { outgoingText: "tidy the imports", turnEffort: "fast" },
    });
    expect(
      resolveComposerSubmission(
        "/fast tidy the imports",
        false,
        context({ turnEffortSupported: false }),
      ),
    ).toEqual({
      kind: "refuse",
      message: "t:turnEffortUnavailable",
      severity: "error",
      restoreText: "/fast tidy the imports",
    });
  });

  it("refuses a slash error, restoring the raw text", () => {
    expect(resolveComposerSubmission("/fast", false, context())).toEqual({
      kind: "refuse",
      message: "Add a request after /fast or /f.",
      severity: "error",
      restoreText: "/fast",
    });
  });

  it("queues /compact unframed, and refuses it on an old server or with attachments", () => {
    expect(
      resolveComposerSubmission("/compact", false, context()),
    ).toMatchObject({ kind: "custom", command: "compact" });
    expect(
      resolveComposerSubmission(
        "/compact",
        true,
        context({ correctionOriginalText: "earlier" }),
      ),
    ).toEqual({
      kind: "submit",
      prepared: { outgoingText: "/compact", queuedCompact: true },
    });
    expect(
      resolveComposerSubmission(
        "/compact",
        true,
        context({ queuedCompactionSupported: false }),
      ),
    ).toMatchObject({
      kind: "refuse",
      message: "t:queuedCompactRequiresUpdate",
    });
    expect(
      resolveComposerSubmission(
        "/compact",
        true,
        context({ pendingUploadCount: 1 }),
      ),
    ).toMatchObject({
      kind: "refuse",
      message: "t:queuedCompactSeparateAttachments",
    });
  });

  it("runs session boundaries, titles and file views locally", () => {
    expect(resolveComposerSubmission("/archive", false, context())).toEqual({
      kind: "local",
      operation: { kind: "session-boundary", command: "archive" },
      endCorrectionFirst: false,
    });
    expect(
      resolveComposerSubmission("/title Release notes", false, context()),
    ).toMatchObject({
      kind: "local",
      operation: { kind: "title", title: "Release notes" },
    });
    expect(
      resolveComposerSubmission("/v src/app.ts", false, context()),
    ).toMatchObject({
      kind: "local",
      operation: { kind: "view", argument: "src/app.ts" },
    });
    expect(
      resolveComposerSubmission(
        "/v src/app.ts",
        false,
        context({ fileViewCommandSupported: false }),
      ),
    ).toMatchObject({ kind: "custom", command: "view" });
  });

  it("refuses a blocked session operation and /btw without a fork path", () => {
    expect(
      resolveComposerSubmission(
        "/archive",
        false,
        context({ attachmentCount: 1 }),
      ),
    ).toMatchObject({
      kind: "refuse",
      severity: "error",
      restoreText: "/archive",
    });
    expect(
      resolveComposerSubmission(
        "/btw check this",
        false,
        context({ btwAsidesSupported: false }),
      ),
    ).toMatchObject({
      kind: "refuse",
      message:
        "/btw asides are available only for providers with a wired fork path.",
    });
    expect(
      resolveComposerSubmission("/btw check this", false, context()),
    ).toMatchObject({ kind: "custom", command: "btw" });
  });

  it("tries other slash commands as custom commands, falling back to their text only", () => {
    expect(resolveComposerSubmission("/model", false, context())).toEqual({
      kind: "custom",
      command: "model",
      argument: "",
      endCorrectionIfHandled: false,
      fallback: { kind: "submit", prepared: { outgoingText: "/model" } },
    });
  });

  describe("while correcting", () => {
    const correcting = context({ correctionOriginalText: "Use tabs" });

    it("frames the correction", () => {
      const decision = resolveComposerSubmission(
        "Use spaces",
        false,
        correcting,
      );
      expect(decision.kind).toBe("submit");
      const outgoing =
        decision.kind === "submit" ? decision.prepared.outgoingText : "";
      expect(outgoing).toBe(buildCorrectionText("Use tabs", "Use spaces"));
      expect(outgoing).not.toBe("Use spaces");
    });

    it("refuses an unchanged correction with an info toast, restoring the candidate", () => {
      expect(resolveComposerSubmission("Use tabs", false, correcting)).toEqual({
        kind: "refuse",
        message: "t:sessionCorrectionNoChanges",
        severity: "info",
        restoreText: "Use tabs",
      });
    });

    it("ends correction before a local command and after a handled custom one", () => {
      expect(
        resolveComposerSubmission("/archive", false, correcting),
      ).toMatchObject({ kind: "local", endCorrectionFirst: true });
      expect(
        resolveComposerSubmission("/model", false, correcting),
      ).toMatchObject({
        kind: "custom",
        endCorrectionIfHandled: true,
        fallback: { kind: "submit", prepared: { outgoingText: "/model" } },
      });
    });

    it("sends a slash command unframed", () => {
      expect(
        resolveComposerSubmission("/fast tidy up", false, correcting),
      ).toMatchObject({
        kind: "submit",
        prepared: { outgoingText: "tidy up", turnEffort: "fast" },
      });
    });
  });
});

const oldServer = { current: "0.7.1", capabilities: [] };
const currentServer = { current: "99.0.0" };

describe("planSend", () => {
  const base = {
    metadata: undefined,
    processState: "idle",
    goalActive: false,
    preserveComposer: false,
    localControlRequested: false,
    version: currentServer,
    attachmentCount: 0,
  };

  it("sends a plain message as it is", () => {
    expect(planSend({ ...base, prepared: { outgoingText: "hello" } })).toEqual({
      kind: "send",
      metadata: undefined,
      localControl: false,
    });
  });

  it("queues a turn-effort turn while busy, before anything else", () => {
    for (const processState of ["in-turn", "waiting-input"]) {
      expect(
        planSend({
          ...base,
          processState,
          version: oldServer,
          attachmentCount: 1,
          prepared: { outgoingText: "", turnEffort: "fast" },
        }),
      ).toEqual({ kind: "queue-instead" });
    }
  });

  it("merges turn effort as direct delivery, keeping the caller's intent and steerNow", () => {
    expect(
      planSend({
        ...base,
        prepared: { outgoingText: "tidy", turnEffort: "fast" },
      }),
    ).toMatchObject({
      metadata: {
        composition: {},
        deliveryIntent: "direct",
        turnEffort: "fast",
      },
    });
    expect(
      planSend({
        ...base,
        metadata: { composition: {}, deliveryIntent: "steer", steerNow: true },
        prepared: { outgoingText: "tidy", turnEffort: "fast" },
      }),
    ).toMatchObject({
      metadata: { deliveryIntent: "steer", steerNow: true, turnEffort: "fast" },
    });
  });

  it("treats /goal as local control only while a goal is active", () => {
    const goal = { ...base, prepared: { outgoingText: "/goal pause" } };
    expect(planSend(goal)).toMatchObject({ localControl: false });
    expect(planSend({ ...goal, goalActive: true })).toMatchObject({
      localControl: true,
    });
    expect(
      planSend({
        ...base,
        localControlRequested: true,
        prepared: { outgoingText: "x" },
      }),
    ).toMatchObject({ localControl: true });
  });

  it("refuses an attachment-only message to an old server unless preserving the composer", () => {
    const attachmentOnly = {
      ...base,
      version: oldServer,
      attachmentCount: 1,
      prepared: { outgoingText: "" },
    };
    expect(planSend(attachmentOnly)).toEqual({
      kind: "refuse-attachment-only",
    });
    expect(
      planSend({ ...attachmentOnly, preserveComposer: true }),
    ).toMatchObject({ kind: "send" });
    expect(
      planSend({ ...attachmentOnly, version: currentServer }),
    ).toMatchObject({ kind: "send" });
  });
});

describe("planQueue", () => {
  it("forces deferred delivery and clears steerNow for turn effort", () => {
    expect(
      planQueue({
        prepared: { outgoingText: "tidy", turnEffort: "fast" },
        metadata: { composition: {}, deliveryIntent: "steer", steerNow: true },
        version: currentServer,
        attachmentCount: 0,
      }),
    ).toEqual({
      kind: "queue",
      metadata: {
        composition: {},
        deliveryIntent: "deferred",
        turnEffort: "fast",
        steerNow: undefined,
      },
    });
  });

  it("refuses an attachment-only message to an old server", () => {
    expect(
      planQueue({
        prepared: { outgoingText: "" },
        metadata: undefined,
        version: oldServer,
        attachmentCount: 1,
      }),
    ).toEqual({ kind: "refuse-attachment-only" });
  });
});

describe("send and queue failures", () => {
  const httpError = (message: string, status?: number) =>
    Object.assign(new Error(message), { status });

  it("confirms a delivered send first, then follows a stale redirect", () => {
    const stale = Object.assign(new Error("This session has gone cold"), {
      reason: "stale-session",
      staleRedirect: "stale-handoff",
    });
    expect(firstSendFailureStep(stale, true)).toBe("delivered");
    expect(firstSendFailureStep(stale, false)).toBe("stale-redirect");
    expect(firstSendFailureStep(new Error("API error: 403"), false)).toBe(
      "continue",
    );
  });

  it("retries with a resume when the process is gone, never for a queued compact", () => {
    for (const error of [
      new Error("API error: 404"),
      new Error("No active process"),
      new Error("Process terminated"),
      httpError("gone", 404),
      httpError("gone", 410),
    ]) {
      expect(shouldRetryWithResume(error)).toBe(true);
    }
    expect(shouldRetryWithResume(httpError("gone", 410), true)).toBe(false);
    expect(shouldRetryWithResume(httpError("conflict", 409))).toBe(false);
    expect(shouldRetryWithResume("No active process")).toBe(false);
  });

  describe("finalFailureNotice", () => {
    const t = (key: string, vars?: Record<string, string>) =>
      `t:${key}${vars ? `:${vars.message}` : ""}`;
    const handoff = (message: string) =>
      Object.assign(new Error(message), {
        status: 409,
        recovery: "handoff-required",
      });

    it("offers a handoff with the server's text", () => {
      expect(
        finalFailureNotice({
          finalError: handoff("Start a handoff session."),
          provider: "claude",
          routedSession: false,
          path: "send",
          t,
        }),
      ).toEqual({
        openHandoffDialog: true,
        message: "Start a handoff session.",
      });
    });

    it("uses the built-in explanation when the refusal has no text", () => {
      expect(
        finalFailureNotice({
          finalError: handoff("API error: 409 Conflict"),
          provider: "claude",
          routedSession: false,
          path: "queue",
          t,
        }),
      ).toEqual({
        openHandoffDialog: true,
        message: CLAUDE_HANDOFF_REQUIRED_MESSAGE,
      });
    });

    it("explains without a dialog for a routed session", () => {
      expect(
        finalFailureNotice({
          finalError: handoff("Start a handoff session."),
          provider: "claude",
          routedSession: true,
          path: "send",
          t,
        }),
      ).toEqual({
        openHandoffDialog: false,
        message: "t:routedSessionHandoffRequired",
      });
    });

    it("falls back to each path's failure message", () => {
      for (const [path, key] of [
        ["send", "sessionSendFailed"],
        ["queue", "sessionQueueFailed"],
      ] as const) {
        expect(
          finalFailureNotice({
            finalError: new Error("boom"),
            provider: "claude",
            routedSession: false,
            path,
            t,
          }),
        ).toEqual({ openHandoffDialog: false, message: `t:${key}:boom` });
      }
      expect(
        finalFailureNotice({
          finalError: handoff("Start a handoff session."),
          provider: "codex",
          routedSession: false,
          path: "send",
          t,
        }),
      ).toMatchObject({ openHandoffDialog: false });
    });
  });
});

describe("Project Queue decisions", () => {
  const t = (key: string, vars?: Record<string, string>) =>
    vars ? `t:${key}:${Object.values(vars).join(",")}` : `t:${key}`;
  const command = (
    text: string,
    overrides: Partial<Parameters<typeof resolveProjectQueueCommand>[0]> = {},
  ) =>
    resolveProjectQueueCommand({
      text,
      targetType: "existing-session",
      rewindSupported: true,
      fileViewSupported: true,
      attachmentCount: 0,
      pendingUploadCount: 0,
      t,
      ...overrides,
    });

  it("prepares a prompt and refuses commands that cannot be queued", () => {
    expect(command("Run the checks")).toEqual({ kind: "prepare" });
    expect(command("/model")).toEqual({
      kind: "refuse",
      message: "t:projectQueueComposerOnlyCommand:model",
    });
    expect(command("/fork 2")).toEqual({
      kind: "refuse",
      message: "t:projectQueueUnsupportedCommand:fork",
    });
    expect(command("/clear abc")).toEqual({
      kind: "refuse",
      message: "t:projectQueueCommandSyntax:clear",
    });
    // Without rewind support a rewind command is an ordinary prompt.
    expect(command("/clear 2", { rewindSupported: false })).toEqual({
      kind: "prepare",
    });
  });

  it("carries a queueable command as its command text, only to an existing session without attachments", () => {
    expect(command("/clear 2")).toMatchObject({
      kind: "queueable",
      prepared: { outgoingText: "/clear 2" },
      yaCommand: { name: "clear" },
    });
    expect(command("/clear")).toEqual({
      kind: "refuse",
      message: "t:projectQueueClearZero",
    });
    expect(command("/clear 2", { targetType: "new-session" })).toEqual({
      kind: "refuse",
      message: "t:projectQueueCommandNeedsSession:clear",
    });
    for (const uploads of [{ attachmentCount: 1 }, { pendingUploadCount: 1 }]) {
      expect(command("/clear 2", uploads)).toEqual({
        kind: "refuse",
        message: "t:projectQueueCommandNoAttachments:clear",
      });
    }
  });

  const plan = (
    overrides: Partial<Parameters<typeof planProjectQueue<string>>[0]> = {},
  ) =>
    planProjectQueue<string>({
      prepared: { outgoingText: "Do it" },
      metadata: undefined,
      targetType: "new-session",
      newSessionTarget: undefined,
      projectId: "here",
      provider: "claude",
      sessionModel: undefined,
      defaultModel: () => "saved-model",
      version: { current: "99.0.0" },
      attachmentCount: 0,
      ...overrides,
    });

  it("targets this project and provider unless the options choose others", () => {
    expect(plan({ sessionModel: "session-model" })).toMatchObject({
      queueProjectId: "here",
      newSessionProvider: "claude",
      keepsProvider: true,
      newSessionModel: "session-model",
      startsNow: false,
      canonicalCreation: false,
    });
    expect(plan()).toMatchObject({ newSessionModel: "saved-model" });
    // A chosen model wins, and the saved default is not read.
    expect(
      plan({
        sessionModel: "session-model",
        newSessionTarget: { model: "chosen" },
        defaultModel: () => {
          throw new Error("read");
        },
      }),
    ).toMatchObject({ newSessionModel: "chosen" });
    expect(
      plan({
        newSessionTarget: { projectId: "there", provider: "codex" },
      }),
    ).toMatchObject({
      queueProjectId: "there",
      newSessionProvider: "codex",
      keepsProvider: false,
      newSessionModel: undefined,
    });
    expect(
      plan({
        targetType: "existing-session",
        newSessionTarget: { projectId: "there" },
      }),
    ).toMatchObject({ queueProjectId: "here" });
  });

  it("starts now with durable admission only on servers that support it", () => {
    const now = { newSessionTarget: { delivery: "now" as const } };
    expect(
      plan({
        ...now,
        version: { capabilities: ["session-creation-admission-v1"] },
      }),
    ).toMatchObject({
      startsNow: true,
      canonicalCreation: true,
    });
    expect(
      plan({ ...now, version: { current: "0.11.0", capabilities: [] } }),
    ).toMatchObject({ startsNow: true, canonicalCreation: false });
  });

  it("refuses an attachment-only message to this session on an old server", () => {
    const attachmentOnly = {
      prepared: { outgoingText: "" },
      attachmentCount: 1,
      version: { current: "0.7.1", capabilities: [] },
    };
    expect(
      plan({ ...attachmentOnly, targetType: "existing-session" }),
    ).toMatchObject({ refuseAttachmentOnly: true });
    // New sessions stage their files, so the old-server limit does not apply.
    expect(
      plan({ ...attachmentOnly, targetType: "new-session" }),
    ).toMatchObject({ refuseAttachmentOnly: false });
    expect(
      plan({
        ...attachmentOnly,
        targetType: "existing-session",
        version: { current: "99.0.0" },
      }),
    ).toMatchObject({ refuseAttachmentOnly: false });
  });

  it("merges turn effort as deferred delivery", () => {
    expect(
      plan({ prepared: { outgoingText: "x", turnEffort: "fast" } }).metadata,
    ).toEqual({
      composition: {},
      deliveryIntent: "deferred",
      turnEffort: "fast",
      steerNow: undefined,
    });
  });

  it("names another project in the queued toast", () => {
    const base = { projectId: "here", projectName: undefined, t };
    expect(
      projectQueueQueuedMessage({
        ...base,
        targetType: "new-session",
        queueProjectId: "there",
        projectName: "Other",
      }),
    ).toBe("t:projectQueueNewSessionQueuedInProjectToast:Other");
    expect(
      projectQueueQueuedMessage({
        ...base,
        targetType: "new-session",
        queueProjectId: "here",
      }),
    ).toBe("t:projectQueueNewSessionQueuedToast");
    expect(
      projectQueueQueuedMessage({
        ...base,
        targetType: "existing-session",
        queueProjectId: "here",
      }),
    ).toBe("t:projectQueueSessionQueuedToast");
  });
});
