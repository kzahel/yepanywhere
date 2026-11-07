import { describe, expect, it } from "vitest";
import { buildCorrectionText } from "../correctionText";
import {
  type ComposerSubmissionContext,
  resolveComposerSubmission,
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
