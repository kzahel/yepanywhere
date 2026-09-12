import { describe, expect, it } from "vitest";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import type { Message, SessionMetadata } from "../../../types";
import { createFinalMarkdownAugmentAction } from "../actionAdapters";
import { selectSessionDetailProjectionAugments } from "../selectors";
import {
  createInitialSessionDetailState,
  reduceSessionDetailActions,
  reduceSessionDetailState,
} from "../transcriptReducer";

function sessionMetadata(provider = "claude"): SessionMetadata {
  return {
    id: "session-augments",
    projectId: "project-1",
    provider,
    title: "Session augments",
    updatedAt: "2026-07-01T12:00:00.000Z",
    createdAt: "2026-07-01T12:00:00.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
  } as SessionMetadata;
}

function assistantMessage(uuid: string, text: string): Message {
  return {
    uuid,
    type: "assistant",
    timestamp: "2026-07-01T12:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function getFirstTextAugmentHtml(messages: Message[]) {
  const items = compileTranscriptProjection(
    messages,
    selectSessionDetailProjectionAugments({
      ...createInitialSessionDetailState(),
      messages,
      markdownAugments: {},
    }),
  );
  return items.find((item) => item.type === "text")?.augmentHtml;
}

function getStateTextAugmentHtml(
  state: ReturnType<typeof createInitialSessionDetailState>,
) {
  const items = compileTranscriptProjection(
    state.messages,
    selectSessionDetailProjectionAugments(state),
  );
  return items.find((item) => item.type === "text")?.augmentHtml;
}

describe("transcriptReducer markdown augments", () => {
  it("retains a final markdown augment that arrives before its message", () => {
    const html = "<p>Rendered <strong>answer</strong>.</p>";
    const state = reduceSessionDetailActions([
      createFinalMarkdownAugmentAction({
        messageId: "assistant-1",
        html,
      }),
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata(),
        messages: [assistantMessage("assistant-1", "Rendered answer.")],
      },
    ]);

    expect(state.markdownAugments).toEqual({
      "assistant-1": { html },
    });
    expect(getStateTextAugmentHtml(state)).toBe(html);
  });

  it("attaches a final markdown augment that arrives after its message", () => {
    const html = "<p>Rendered after load.</p>";
    const state = reduceSessionDetailActions([
      {
        type: "loadPersistedTranscript",
        session: sessionMetadata(),
        messages: [assistantMessage("assistant-1", "Rendered after load.")],
      },
      createFinalMarkdownAugmentAction({
        messageId: "assistant-1",
        html,
      }),
    ]);

    expect(getStateTextAugmentHtml(state)).toBe(html);
  });

  it("uses markdown augments supplied by a persisted transcript load", () => {
    const html = "<p>Loaded with the transcript.</p>";
    const state = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "loadPersistedTranscript",
      session: sessionMetadata(),
      messages: [
        assistantMessage("assistant-1", "Loaded with the transcript."),
      ],
      markdownAugments: {
        "assistant-1": { html },
      },
    });

    expect(getStateTextAugmentHtml(state)).toBe(html);
  });

  it("keeps a final markdown augment on its exact Codex id", () => {
    const html = "<p>Rendered durable answer.</p>";
    const messageId = "msg_019b8510_augment";
    const state = reduceSessionDetailActions(
      [
        {
          type: "applyStreamMessage",
          message: assistantMessage(messageId, "Rendered durable answer."),
        },
        createFinalMarkdownAugmentAction({
          messageId,
          html,
        }),
        {
          type: "applyCatchupMessages",
          session: sessionMetadata("codex"),
          messages: [assistantMessage(messageId, "Rendered durable answer.")],
        },
      ],
      {
        ...createInitialSessionDetailState(),
        session: sessionMetadata("codex"),
      },
    );

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.uuid).toBe(messageId);
    expect(state.markdownAugments).toEqual({
      [messageId]: { html },
    });
    expect(getStateTextAugmentHtml(state)).toBe(html);
  });

  it("does not update state for duplicate markdown augment HTML", () => {
    const first = reduceSessionDetailState(createInitialSessionDetailState(), {
      type: "applyFinalMarkdownAugment",
      messageId: "assistant-1",
      augment: { html: "<p>One</p>" },
    });
    const duplicate = reduceSessionDetailState(first, {
      type: "applyFinalMarkdownAugment",
      messageId: "assistant-1",
      augment: { html: "<p>One</p>" },
    });
    const updated = reduceSessionDetailState(duplicate, {
      type: "applyFinalMarkdownAugment",
      messageId: "assistant-1",
      augment: { html: "<p>Two</p>" },
    });

    expect(duplicate).toBe(first);
    expect(updated).not.toBe(first);
    expect(updated.markdownAugments["assistant-1"]).toEqual({
      html: "<p>Two</p>",
    });
  });

  it("returns no preprocess augments when no data-level augments exist", () => {
    expect(
      getFirstTextAugmentHtml([assistantMessage("assistant-1", "Plain.")]),
    ).toBeUndefined();
    expect(
      selectSessionDetailProjectionAugments(createInitialSessionDetailState()),
    ).toBeUndefined();
  });
});
