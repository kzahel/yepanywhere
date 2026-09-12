import type { TranscriptDisplayObject } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { Message } from "../../../types";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import {
  buildComposerTailItems,
  buildComposerTailDisplayRows,
  buildAssistantRenderSegments,
  buildAssistantTimelineRows,
  buildSessionDetailRenderItems,
  buildTimelineEntryDisplayRows,
  buildVisibleTimelineEntries,
  countThinkingItems,
  getActiveSearchAnchors,
  getAllTurnSearchAnchors,
  getComposerTailLanePositions,
  getDisplayRenderItems,
  getFullSessionSearchAnchors,
  getLastTimestampedRenderItem,
  getLatestThinkingItemId,
  getLatestVisibleTimestampMs,
  getNextProgressiveEntryCount,
  getProgressiveTimelineVisibility,
  getProgressiveTimelineEntryWeight,
  getSearchMatchProjection,
  getSearchNavigatorStateProjection,
  getSearchPanelProjection,
  getSearchReady,
  getSearchSelectionProjection,
  getSearchVisibleTurnGroups,
  getTailEntryCountForRenderItemTarget,
  getThinkingDurationMs,
  getThinkingItemIds,
  getThinkingTextLengths,
  getUserTurnNavAnchors,
  getUserTurnSearchAnchors,
  groupEndsVisibleTurn,
  groupRenderItemsIntoTurns,
  hasSearchableUserTurn,
  hasVisibleThinkingTextDelta,
  isPatientDeferredMessage,
  isRecoveredDeferredMessage,
  reconcileAutoExpandedThinkingItemIds,
  selectSessionDetailRenderItems,
  selectLatestCorrectablePrompt,
  type ProgressiveTimelineEntry,
  type RenderTimelineEntry,
  type RenderTurnGroup,
} from "../renderSelectors";
import { createInitialSessionDetailState } from "../transcriptReducer";

function displayObject(
  id: string,
  placementAfterMessageId: string,
): TranscriptDisplayObject {
  return {
    id,
    kind: "fork-summary",
    createdAt: "2026-06-23T00:00:00.000Z",
    placementAfterMessageId,
    sourceMessageId: "user-1",
    retainedThroughMessageId: "assistant-1",
    status: "generating",
  };
}

function sourceMessage(id: string, timestamp: string): Message {
  return {
    type: "assistant",
    uuid: id,
    timestamp,
    message: { role: "assistant", content: "" },
  };
}

describe("session detail render selectors", () => {
  it("builds and stabilizes render items from transcript inputs", () => {
    const messages: Message[] = [
      {
        id: "user-1",
        type: "user",
        message: { role: "user", content: "hello" },
      },
      {
        id: "assistant-1",
        type: "assistant",
        message: { role: "assistant", content: "hi" },
      },
    ];
    const transcriptDisplayObjects = [displayObject("display-1", "user-1")];

    const first = buildSessionDetailRenderItems({
      messages,
      transcriptDisplayObjects,
    });
    const second = buildSessionDetailRenderItems({
      messages,
      transcriptDisplayObjects,
      previousRenderItems: first,
    });

    expect(first.map((item) => `${item.type}:${item.id}`)).toEqual([
      "user_prompt:user-1",
      "transcript_display_object:display-1",
      "text:assistant-1",
    ]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
  });

  it("hides only Claude Gateway empty-summary thinking placeholders", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "encrypted-1@reasoning-1",
            },
            {
              type: "thinking",
              thinking: "Detailed reasoning summary",
              signature: "encrypted-2@reasoning-2",
            },
          ],
        },
      },
    ];

    expect(
      buildSessionDetailRenderItems({
        messages,
        provider: "claude-gateway",
      }).map((item) => (item.type === "thinking" ? item.thinking : item.type)),
    ).toEqual(["Detailed reasoning summary"]);
    expect(
      buildSessionDetailRenderItems({
        messages,
        provider: "claude",
      }).map((item) => (item.type === "thinking" ? item.thinking : item.type)),
    ).toEqual(["Thinking...", "Detailed reasoning summary"]);
    expect(messages[0]?.message?.content).toMatchObject([
      { signature: "encrypted-1@reasoning-1" },
      { signature: "encrypted-2@reasoning-2" },
    ]);
  });

  it("selects render items from session detail state with markdown augments", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        type: "assistant",
        message: { role: "assistant", content: "hi" },
      },
    ];
    const state = {
      ...createInitialSessionDetailState(),
      messages,
      markdownAugments: {
        "assistant-1": { html: "<p>hi</p>" },
      },
    };

    const items = selectSessionDetailRenderItems(state);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "text",
      id: "assistant-1",
      augmentHtml: "<p>hi</p>",
    });
  });

  it("groups render items into user, assistant, and standalone turns", () => {
    const [user, display, text] = buildSessionDetailRenderItems({
      messages: [
        {
          id: "user-1",
          type: "user",
          message: { role: "user", content: "hello" },
        },
        {
          id: "assistant-1",
          type: "assistant",
          message: { role: "assistant", content: "hi" },
        },
      ],
      transcriptDisplayObjects: [displayObject("display-1", "user-1")],
    });

    const groups = groupRenderItemsIntoTurns(
      [user, display, text].filter((item): item is NonNullable<typeof item> =>
        Boolean(item),
      ),
    );

    expect(
      groups.map((group) => ({
        isUserPrompt: group.isUserPrompt,
        isStandalone: group.isStandalone ?? false,
        ids: group.items.map((item) => item.id),
      })),
    ).toEqual([
      { isUserPrompt: true, isStandalone: false, ids: ["user-1"] },
      { isUserPrompt: false, isStandalone: true, ids: ["display-1"] },
      { isUserPrompt: false, isStandalone: false, ids: ["assistant-1"] },
    ]);
  });

  it("derives timestamp helper primitives for visible turns", () => {
    const user: RenderItem = {
      type: "user_prompt",
      id: "user-1",
      content: "Request",
      sourceMessages: [sourceMessage("user-1", "2026-07-02T12:00:00.000Z")],
    };
    const untimestamped: RenderItem = {
      type: "text",
      id: "assistant-untimed",
      text: "No timestamp",
      sourceMessages: [],
    };
    const answer: RenderItem = {
      type: "text",
      id: "assistant-1",
      text: "Answer",
      sourceMessages: [
        sourceMessage("assistant-1", "2026-07-02T12:02:00.000Z"),
      ],
    };
    const display: RenderItem = {
      type: "transcript_display_object",
      id: "display-1",
      object: displayObject("display-1", "user-1"),
      sourceMessages: [],
    };
    const userGroup: RenderTurnGroup = { isUserPrompt: true, items: [user] };
    const assistantGroup: RenderTurnGroup = {
      isUserPrompt: false,
      items: [untimestamped, answer],
    };
    const standaloneGroup: RenderTurnGroup = {
      isUserPrompt: false,
      isStandalone: true,
      items: [display],
    };

    expect(getLastTimestampedRenderItem([user, untimestamped, answer])).toBe(
      answer,
    );
    expect(getLastTimestampedRenderItem([untimestamped])).toBeNull();
    expect(groupEndsVisibleTurn(userGroup, assistantGroup)).toBe(false);
    expect(groupEndsVisibleTurn(userGroup, standaloneGroup)).toBe(true);
    expect(groupEndsVisibleTurn(userGroup, undefined)).toBe(true);
    expect(groupEndsVisibleTurn(assistantGroup, undefined)).toBe(true);
    expect(groupEndsVisibleTurn(standaloneGroup, assistantGroup)).toBe(true);
  });

  it("derives the latest visible timestamp across transcript and tail inputs", () => {
    const displayRenderItems: RenderItem[] = [
      {
        type: "text",
        id: "assistant-1",
        text: "Earlier answer",
        sourceMessages: [
          sourceMessage("assistant-1", "2026-07-02T12:00:00.000Z"),
        ],
      },
      {
        type: "text",
        id: "assistant-2",
        text: "Later answer",
        sourceMessages: [
          sourceMessage("assistant-2a", "2026-07-02T12:01:00.000Z"),
          sourceMessage("assistant-2b", "2026-07-02T12:02:00.000Z"),
        ],
      },
    ];
    const asides = [
      {
        id: "aside-1",
        updatedAt: "2026-07-02T12:05:00.000Z",
      },
    ];
    const deferredMessages = [
      { tempId: "deferred-1", timestamp: "not-a-date" },
    ];
    const pendingMessages = [
      { tempId: "pending-1", timestamp: "2026-07-02T12:03:00.000Z" },
    ];
    const projectQueueMessages = [
      {
        id: "project-1",
        projectPosition: 0,
        timestamp: "2026-07-02T12:04:00.000Z",
      },
    ];

    expect(
      getLatestVisibleTimestampMs({
        asides,
        deferredMessages,
        displayRenderItems,
        pendingMessages,
        projectQueueMessages,
      }),
    ).toBe(Date.parse("2026-07-02T12:05:00.000Z"));
    expect(getLatestVisibleTimestampMs({ displayRenderItems: [] })).toBeNull();
  });

  it("derives composer tail ordering and deferred lane positions", () => {
    const tailItems = buildComposerTailItems({
      deferredMessages: [
        {
          attachmentCount: 1,
          id: "queue-regular-1",
          tempId: "deferred-regular-1",
          timestamp: "2026-07-02T12:10:00.000Z",
        },
        {
          tempId: "deferred-patient-1",
          timestamp: "2026-07-02T12:09:00.000Z",
          metadata: { deliveryIntent: "patient" },
        },
        {
          attachmentCount: 3,
          id: "queue-regular-2",
          tempId: "deferred-regular-2",
          timestamp: "2026-07-02T12:08:00.000Z",
          status: "paused-after-restart",
        },
      ],
      pendingMessages: [
        {
          tempId: "pending-second",
          timestamp: "2026-07-02T12:01:00.000Z",
          clientOrder: 2,
        },
        {
          tempId: "pending-first",
          timestamp: "2026-07-02T12:02:00.000Z",
          clientOrder: 1,
        },
      ],
      projectQueueMessages: [
        {
          attachmentCount: 2,
          id: "project-second",
          status: "dispatching",
          timestamp: "2026-07-02T12:20:00.000Z",
          projectPosition: 2,
        },
        {
          attachmentCount: 1,
          attachments: [{}],
          id: "project-first",
          status: "queued",
          timestamp: "2026-07-02T12:21:00.000Z",
          projectPosition: 1,
        },
      ],
    });

    expect(tailItems.map((item) => item.key)).toEqual([
      "pending-first",
      "pending-second",
      "deferred-regular-1",
      "deferred-patient-1",
      "deferred-regular-2",
      "project-queue-project-first",
      "project-queue-project-second",
    ]);

    const positions = getComposerTailLanePositions(tailItems);
    expect(positions.get("deferred-regular-1")).toEqual({ regularIndex: 0 });
    expect(positions.get("deferred-patient-1")).toEqual({ patientIndex: 0 });
    expect(positions.get("deferred-regular-2")).toEqual({ regularIndex: 1 });
    expect(positions.has("pending-first")).toBe(false);

    const patient = tailItems.find((item) => item.key === "deferred-patient-1");
    const recovered = tailItems.find(
      (item) => item.key === "deferred-regular-2",
    );
    expect(
      patient?.kind === "deferred" && isPatientDeferredMessage(patient.message),
    ).toBe(true);
    expect(
      recovered?.kind === "deferred" &&
        isRecoveredDeferredMessage(recovered.message),
    ).toBe(true);

    const rows = buildComposerTailDisplayRows({
      deferredMessages: [
        {
          attachmentCount: 1,
          id: "queue-regular-1",
          tempId: "deferred-regular-1",
          timestamp: "2026-07-02T12:10:00.000Z",
        },
        {
          tempId: "deferred-patient-1",
          timestamp: "2026-07-02T12:09:00.000Z",
          metadata: { deliveryIntent: "patient" },
        },
        {
          attachmentCount: 3,
          id: "queue-regular-2",
          tempId: "deferred-regular-2",
          timestamp: "2026-07-02T12:08:00.000Z",
          status: "paused-after-restart",
        },
      ],
      latestVisibleTimestampMs: Date.parse("2026-07-02T12:21:00.000Z"),
      nowMs: Date.parse("2026-07-02T12:30:00.000Z"),
      pendingMessages: [
        {
          tempId: "pending-second",
          timestamp: "2026-07-02T12:01:00.000Z",
          clientOrder: 2,
        },
        {
          tempId: "pending-first",
          timestamp: "2026-07-02T12:02:00.000Z",
          clientOrder: 1,
        },
      ],
      projectQueueMessages: [
        {
          attachmentCount: 2,
          id: "project-second",
          status: "dispatching",
          timestamp: "2026-07-02T12:20:00.000Z",
          projectPosition: 2,
        },
        {
          attachmentCount: 1,
          attachments: [{}],
          id: "project-first",
          status: "queued",
          timestamp: "2026-07-02T12:21:00.000Z",
          projectPosition: 1,
        },
      ],
      staleThresholdMs: 5 * 60 * 1000,
    });

    expect(
      rows.map((row) => ({
        kind: row.kind,
        key: row.key,
        hasMessageAge: row.hasMessageAge,
        showAgeByDefault: row.showAgeByDefault,
        timestampMs: row.timestampMs,
      })),
    ).toEqual([
      {
        kind: "pending",
        key: "pending-first",
        hasMessageAge: true,
        showAgeByDefault: false,
        timestampMs: Date.parse("2026-07-02T12:02:00.000Z"),
      },
      {
        kind: "pending",
        key: "pending-second",
        hasMessageAge: true,
        showAgeByDefault: false,
        timestampMs: Date.parse("2026-07-02T12:01:00.000Z"),
      },
      {
        kind: "deferred",
        key: "deferred-regular-1",
        hasMessageAge: true,
        showAgeByDefault: false,
        timestampMs: Date.parse("2026-07-02T12:10:00.000Z"),
      },
      {
        kind: "deferred",
        key: "deferred-patient-1",
        hasMessageAge: true,
        showAgeByDefault: false,
        timestampMs: Date.parse("2026-07-02T12:09:00.000Z"),
      },
      {
        kind: "deferred",
        key: "deferred-regular-2",
        hasMessageAge: true,
        showAgeByDefault: false,
        timestampMs: Date.parse("2026-07-02T12:08:00.000Z"),
      },
      {
        kind: "project-queue",
        key: "project-queue-project-first",
        hasMessageAge: true,
        showAgeByDefault: true,
        timestampMs: Date.parse("2026-07-02T12:21:00.000Z"),
      },
      {
        kind: "project-queue",
        key: "project-queue-project-second",
        hasMessageAge: true,
        showAgeByDefault: false,
        timestampMs: Date.parse("2026-07-02T12:20:00.000Z"),
      },
    ]);

    const recoveredRow = rows.find(
      (row) => row.kind === "deferred" && row.key === "deferred-regular-2",
    );
    const patientRow = rows.find(
      (row) => row.kind === "deferred" && row.key === "deferred-patient-1",
    );
    const dispatchingProjectRow = rows.find(
      (row) =>
        row.kind === "project-queue" &&
        row.key === "project-queue-project-second",
    );
    const queuedProjectRow = rows.find(
      (row) =>
        row.kind === "project-queue" &&
        row.key === "project-queue-project-first",
    );

    expect(recoveredRow?.kind === "deferred" && recoveredRow.isRecovered).toBe(
      true,
    );
    expect(
      recoveredRow?.kind === "deferred" && recoveredRow.recoveredQueueId,
    ).toBe("queue-regular-2");
    expect(
      recoveredRow?.kind === "deferred" &&
        recoveredRow.showAttachmentCountBadge,
    ).toBe(true);
    expect(
      recoveredRow?.kind === "deferred" && recoveredRow.allowsRecoveredResume,
    ).toBe(true);
    expect(
      recoveredRow?.kind === "deferred" && recoveredRow.allowsRecoveredDelete,
    ).toBe(true);
    expect(
      recoveredRow?.kind === "deferred" && recoveredRow.allowsDeferredCancel,
    ).toBe(true);
    expect(patientRow?.kind === "deferred" && patientRow.isPatient).toBe(true);
    expect(
      patientRow?.kind === "deferred" && patientRow.allowsRecoveredResume,
    ).toBe(false);
    expect(
      patientRow?.kind === "deferred" && patientRow.allowsRecoveredDelete,
    ).toBe(false);
    expect(
      patientRow?.kind === "deferred" && patientRow.allowsDeferredCancel,
    ).toBe(true);
    expect(patientRow?.kind === "deferred" && patientRow.lanePosition).toEqual({
      patientIndex: 0,
    });
    expect(
      dispatchingProjectRow?.kind === "project-queue" &&
        dispatchingProjectRow.projectQueueStatusKind,
    ).toBe("dispatching");
    expect(
      dispatchingProjectRow?.kind === "project-queue" &&
        dispatchingProjectRow.showAttachmentCountBadge,
    ).toBe(true);
    expect(
      dispatchingProjectRow?.kind === "project-queue" &&
        dispatchingProjectRow.allowsCancel,
    ).toBe(false);
    expect(
      queuedProjectRow?.kind === "project-queue" &&
        queuedProjectRow.projectQueueStatusKind,
    ).toBe("queued");
    expect(
      queuedProjectRow?.kind === "project-queue" &&
        queuedProjectRow.showAttachmentCountBadge,
    ).toBe(false);
    expect(
      queuedProjectRow?.kind === "project-queue" &&
        queuedProjectRow.allowsCancel,
    ).toBe(true);
  });

  it("keeps queued YA commands out of provider-delivery lanes", () => {
    const rows = buildComposerTailDisplayRows({
      deferredMessages: [
        {
          tempId: "ya-done-queued",
          timestamp: "2026-08-16T10:00:00.000Z",
          kind: "ya-command",
          yaCommand: "done",
        },
        {
          tempId: "regular-after-command",
          timestamp: "2026-08-16T10:00:01.000Z",
        },
      ],
      latestVisibleTimestampMs: null,
      nowMs: Date.parse("2026-08-16T10:00:02.000Z"),
      staleThresholdMs: 5 * 60 * 1000,
    });
    const doneRow = rows.find((row) => row.key === "ya-done-queued");
    const regularRow = rows.find((row) => row.key === "regular-after-command");

    expect(doneRow?.kind === "deferred" && doneRow.isYaCommand).toBe(true);
    expect(doneRow?.kind === "deferred" && doneRow.allowsDeferredCancel).toBe(
      false,
    );
    expect(
      doneRow?.kind === "deferred" && doneRow.lanePosition,
    ).toBeUndefined();
    expect(regularRow?.kind === "deferred" && regularRow.lanePosition).toEqual({
      regularIndex: 0,
    });
  });

  it("derives user navigation anchors from searchable user turns", () => {
    const sourceMessages: Message[] = [
      {
        id: "user-1",
        type: "user",
        timestamp: "2026-07-02T12:00:00.000Z",
        message: { role: "user", content: "Build the parser" },
      },
    ];
    const items: RenderItem[] = [
      {
        type: "user_prompt",
        id: "setup",
        content:
          "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nRead CLAUDE.md\n</INSTRUCTIONS>",
        sourceMessages: [],
      },
      {
        type: "user_prompt",
        id: "user-1",
        content: "Build the parser",
        sourceMessages,
      },
      {
        type: "user_prompt",
        id: "subagent-user-1",
        content: "Subagent note",
        isSubagent: true,
        sourceMessages: [],
      },
    ];

    expect(getUserTurnNavAnchors(items)).toEqual([
      {
        id: "user-1",
        preview: "Build the parser",
        timestampMs: Date.parse("2026-07-02T12:00:00.000Z"),
      },
    ]);
  });

  it("derives user and all-turn search anchors from render items", () => {
    const userMessage: Message = {
      id: "user-1",
      type: "user",
      timestamp: "2026-07-02T12:00:00.000Z",
      message: { role: "user", content: "Find the duplicate prompt" },
    };
    const assistantMessage: Message = {
      id: "assistant-1",
      type: "assistant",
      timestamp: "2026-07-02T12:01:00.000Z",
      message: { role: "assistant", content: "The answer is stable" },
    };
    const items: RenderItem[] = [
      {
        type: "user_prompt",
        id: "user-1",
        content: "Find the duplicate prompt",
        sourceMessages: [userMessage],
      },
      {
        type: "user_prompt",
        id: "setup",
        content: "<environment_context>\ncwd\n</environment_context>",
        sourceMessages: [],
      },
      {
        type: "text",
        id: "assistant-1",
        text: "The answer is stable",
        sourceMessages: [assistantMessage],
      },
      {
        type: "system",
        id: "system-1",
        subtype: "compact_boundary",
        content: "Compacted transcript",
        details: ["retained tail"],
        sourceMessages: [],
      },
    ];

    expect(getUserTurnSearchAnchors(items)).toEqual([
      {
        id: "user-1",
        preview: "Find the duplicate prompt",
        searchText: "Find the duplicate prompt",
        timestampMs: Date.parse("2026-07-02T12:00:00.000Z"),
      },
    ]);

    expect(
      getAllTurnSearchAnchors(items).map((anchor) => ({
        id: anchor.id,
        preview: anchor.preview,
        searchText: anchor.searchText,
      })),
    ).toEqual([
      {
        id: "user-1",
        preview: "Find the duplicate prompt",
        searchText: "Find the duplicate prompt",
      },
      {
        id: "assistant-1",
        preview: "The answer is stable",
        searchText: "The answer is stable",
      },
      {
        id: "system-1",
        preview: "Compacted transcript retained tail",
        searchText: "Compacted transcript\nretained tail",
      },
    ]);
  });

  it("derives full-session anchors for explored assistant segments", () => {
    const read: RenderItem = {
      type: "tool_call",
      id: "read-1",
      toolName: "Read",
      toolInput: { file_path: "README.md" },
      status: "pending",
      sourceMessages: [sourceMessage("read-msg", "2026-07-02T12:01:00.000Z")],
    };
    const grep: RenderItem = {
      type: "tool_call",
      id: "grep-1",
      toolName: "Grep",
      toolInput: { pattern: "needle", path: "src" },
      status: "pending",
      sourceMessages: [sourceMessage("grep-msg", "2026-07-02T12:02:00.000Z")],
    };
    const thinking: RenderItem = {
      type: "thinking",
      id: "thinking-1",
      thinking: "Checking the answer",
      status: "complete",
      sourceMessages: [
        sourceMessage("thinking-msg", "2026-07-02T12:03:00.000Z"),
      ],
    };
    const assistantItems = [read, grep, thinking];

    expect(
      buildAssistantRenderSegments(assistantItems).map((segment) =>
        segment.kind === "explored"
          ? { kind: segment.kind, id: segment.id }
          : { kind: segment.kind, id: segment.item.id },
      ),
    ).toEqual([
      { kind: "explored", id: "explored-read-1-grep-1" },
      { kind: "item", id: "thinking-1" },
    ]);

    const anchors = getFullSessionSearchAnchors([
      {
        isUserPrompt: true,
        items: [
          {
            type: "user_prompt",
            id: "user-1",
            content: "Find usage",
            sourceMessages: [
              sourceMessage("user-msg", "2026-07-02T12:00:00.000Z"),
            ],
          },
        ],
      },
      { isUserPrompt: false, items: assistantItems },
    ]);

    expect(
      anchors.map((anchor) => ({
        id: anchor.id,
        preview: anchor.preview,
        targetId: anchor.targetId,
      })),
    ).toEqual([
      { id: "user-1", preview: "Find usage", targetId: undefined },
      {
        id: "explored-read-1-grep-1",
        preview: "Explored: 2 items",
        targetId: undefined,
      },
      {
        id: "explored-read-1-grep-1:read-1",
        preview: "Explored / Read: README.md",
        targetId: "explored-read-1-grep-1",
      },
      {
        id: "explored-read-1-grep-1:grep-1",
        preview: "Explored / Grep: needle in src",
        targetId: "explored-read-1-grep-1",
      },
      {
        id: "thinking-1",
        preview: "Thinking: Checking the answer",
        targetId: undefined,
      },
    ]);
    expect(
      anchors.find((anchor) => anchor.id === "explored-read-1-grep-1")
        ?.timestampMs,
    ).toBe(Date.parse("2026-07-02T12:02:00.000Z"));
  });

  it("indexes compound exploration entries without synthetic transcript targets", () => {
    const compound: RenderItem = {
      type: "tool_call",
      id: "call-compound",
      toolName: "Bash",
      toolInput: {
        command:
          "sed -n '1,100p' src/session.ts && sed -n '101,200p' src/session.ts && sed -n '1,80p' src/driver.ts",
      },
      displayActions: [
        {
          kind: "read",
          path: "src/session.ts",
          absolutePath: "/workspace/src/session.ts",
          name: "session.ts",
          startLine: 1,
          endLine: 100,
        },
        {
          kind: "read",
          path: "src/session.ts",
          absolutePath: "/workspace/src/session.ts",
          name: "session.ts",
          startLine: 101,
          endLine: 200,
        },
        {
          kind: "read",
          path: "src/driver.ts",
          absolutePath: "/workspace/src/driver.ts",
          name: "driver.ts",
          startLine: 1,
          endLine: 80,
        },
      ],
      status: "complete",
      sourceMessages: [
        sourceMessage("compound-msg", "2026-07-02T12:02:00.000Z"),
      ],
    };
    const groupId = "explored-call-compound-call-compound";
    const anchors = getFullSessionSearchAnchors([
      { isUserPrompt: false, items: [compound] },
    ]);

    expect(
      anchors.map(({ id, preview, targetId }) => ({ id, preview, targetId })),
    ).toEqual([
      {
        id: groupId,
        preview: "Explored: 3 items",
        targetId: undefined,
      },
      {
        id: `${groupId}:entry:call-compound:0`,
        preview: "Explored / Read: src/session.ts lines 1-100",
        targetId: groupId,
      },
      {
        id: `${groupId}:entry:call-compound:1`,
        preview: "Explored / Read: src/session.ts lines 101-200",
        targetId: groupId,
      },
      {
        id: `${groupId}:entry:call-compound:2`,
        preview: "Explored / Read: src/driver.ts lines 1-80",
        targetId: groupId,
      },
    ]);
    expect(anchors.some((anchor) => anchor.id === "call-compound:0")).toBe(
      false,
    );

    const rangeMatches = getSearchMatchProjection({
      anchors,
      query: "101-200",
      searchReady: true,
    });
    expect(rangeMatches.matches.map((anchor) => anchor.id)).toEqual([
      `${groupId}:entry:call-compound:1`,
    ]);
    expect(Array.from(rangeMatches.matchTargetIds)).toEqual([groupId]);

    const rawCommandMatches = getSearchMatchProjection({
      anchors,
      query: "sed -n",
      searchReady: true,
    });
    expect(rawCommandMatches.matches.map((anchor) => anchor.id)).toEqual([
      groupId,
    ]);
  });

  it("derives assistant timeline row metadata", () => {
    const read: RenderItem = {
      type: "tool_call",
      id: "read-1",
      toolName: "Read",
      toolInput: { file_path: "README.md" },
      status: "pending",
      sourceMessages: [sourceMessage("read-msg", "2026-07-02T12:01:00.000Z")],
    };
    const grep: RenderItem = {
      type: "tool_call",
      id: "grep-1",
      toolName: "Grep",
      toolInput: { pattern: "needle", path: "src" },
      status: "pending",
      sourceMessages: [sourceMessage("grep-msg", "2026-07-02T12:02:00.000Z")],
    };
    const thinking: RenderItem = {
      type: "thinking",
      id: "thinking-1",
      thinking: "Checking the answer",
      status: "complete",
      sourceMessages: [
        sourceMessage("thinking-msg", "2026-07-02T12:03:00.000Z"),
      ],
    };
    const answer: RenderItem = {
      type: "text",
      id: "answer-1",
      text: "Done",
      sourceMessages: [sourceMessage("answer-msg", "2026-07-02T12:04:00.000Z")],
    };

    const rows = buildAssistantTimelineRows({
      items: [read, grep, thinking, answer],
      latestVisibleTimestampMs: Date.parse("2026-07-02T12:02:00.000Z"),
      nowMs: Date.parse("2026-07-02T12:10:00.000Z"),
    });

    expect(
      rows.map((row) =>
        row.kind === "explored"
          ? {
              kind: row.kind,
              id: row.id,
              itemIds: row.items.map((item) => item.id),
              segmentTimestampMs: row.segmentTimestampMs,
              staleNowMs: row.staleNowMs,
            }
          : {
              kind: row.kind,
              id: row.item.id,
              itemIndex: row.itemIndex,
              allowsPromptActions: row.allowsPromptActions,
              allowsTextQuote: row.allowsTextQuote,
              allowsThinkingToggle: row.allowsThinkingToggle,
              thinkingDurationMs: row.thinkingDurationMs,
            },
      ),
    ).toEqual([
      {
        kind: "explored",
        id: "explored-read-1-grep-1",
        itemIds: ["read-1", "grep-1"],
        segmentTimestampMs: Date.parse("2026-07-02T12:02:00.000Z"),
        staleNowMs: Date.parse("2026-07-02T12:10:00.000Z"),
      },
      {
        kind: "item",
        id: "thinking-1",
        itemIndex: 2,
        allowsPromptActions: false,
        allowsTextQuote: false,
        allowsThinkingToggle: true,
        thinkingDurationMs: 60_000,
      },
      {
        kind: "item",
        id: "answer-1",
        itemIndex: 3,
        allowsPromptActions: false,
        allowsTextQuote: true,
        allowsThinkingToggle: false,
        thinkingDurationMs: undefined,
      },
    ]);
  });

  it("derives timeline entry display row metadata", () => {
    const user: RenderItem = {
      type: "user_prompt",
      id: "user-1",
      content: "Check the logs",
      sourceMessages: [sourceMessage("user-msg", "2026-07-02T12:00:00.000Z")],
    };
    const subagentUser: RenderItem = {
      type: "user_prompt",
      id: "subagent-user-1",
      content: "Subagent prompt",
      isSubagent: true,
      sourceMessages: [
        sourceMessage("subagent-user-msg", "2026-07-02T12:00:30.000Z"),
      ],
    };
    const standalone: RenderItem = {
      type: "system",
      id: "checkpoint-1",
      subtype: "compact_boundary",
      content: "Compacted context",
      sourceMessages: [
        sourceMessage("checkpoint-msg", "2026-07-02T12:01:00.000Z"),
      ],
    };
    const assistant: RenderItem = {
      type: "text",
      id: "assistant-1",
      text: "Done",
      sourceMessages: [
        sourceMessage("assistant-msg", "2026-07-02T12:02:00.000Z"),
      ],
    };
    const entries: Array<RenderTimelineEntry> = [
      {
        kind: "turn",
        key: "turn-empty",
        timestampMs: null,
        ordinal: 0,
        group: { isUserPrompt: false, items: [] },
      },
      {
        kind: "turn",
        key: "turn-user",
        timestampMs: Date.parse("2026-07-02T12:00:00.000Z"),
        ordinal: 1,
        group: { isUserPrompt: true, items: [user] },
      },
      {
        kind: "turn",
        key: "turn-subagent-user",
        timestampMs: Date.parse("2026-07-02T12:00:30.000Z"),
        ordinal: 2,
        group: { isUserPrompt: true, items: [subagentUser] },
      },
      {
        kind: "turn",
        key: "turn-standalone",
        timestampMs: Date.parse("2026-07-02T12:01:00.000Z"),
        ordinal: 3,
        group: {
          isStandalone: true,
          isUserPrompt: false,
          items: [standalone],
        },
      },
      {
        kind: "turn",
        key: "turn-assistant",
        timestampMs: Date.parse("2026-07-02T12:02:00.000Z"),
        ordinal: 4,
        group: { isUserPrompt: false, items: [assistant] },
      },
      {
        kind: "btw",
        key: "btw-aside-1",
        timestampMs: Date.parse("2026-07-02T12:03:00.000Z"),
        ordinal: 5,
        aside: {
          id: "aside-1",
          updatedAt: "2026-07-02T12:03:00.000Z",
        },
      },
    ];

    const rows = buildTimelineEntryDisplayRows({
      entries,
      latestCorrectablePromptId: "user-1",
      latestVisibleTimestampMs: Date.parse("2026-07-02T12:00:00.000Z"),
      nowMs: Date.parse("2026-07-02T12:10:00.000Z"),
    });

    expect(
      rows.map((row) => {
        if (row.kind === "btw") {
          return {
            kind: row.kind,
            key: row.key,
            asideId: row.aside.id,
          };
        }
        if (row.kind === "empty") {
          return {
            kind: row.kind,
            key: row.key,
          };
        }
        if (row.kind === "assistant") {
          return {
            kind: row.kind,
            key: row.key,
            firstItemId: row.group.items[0]?.id,
            rows: row.rows.map((assistantRow) =>
              assistantRow.kind === "item"
                ? {
                    kind: assistantRow.kind,
                    id: assistantRow.item.id,
                    itemIndex: assistantRow.itemIndex,
                    allowsPromptActions: assistantRow.allowsPromptActions,
                    allowsTextQuote: assistantRow.allowsTextQuote,
                    allowsThinkingToggle: assistantRow.allowsThinkingToggle,
                    staleNowMs: assistantRow.staleNowMs,
                    thinkingDurationMs: assistantRow.thinkingDurationMs,
                  }
                : {
                    kind: assistantRow.kind,
                    id: assistantRow.id,
                    itemIds: assistantRow.items.map((item) => item.id),
                    segmentTimestampMs: assistantRow.segmentTimestampMs,
                    staleNowMs: assistantRow.staleNowMs,
                  },
            ),
          };
        }
        return {
          kind: row.kind,
          key: row.key,
          id: row.item.id,
          allowsPromptActions:
            row.kind === "user" ? row.allowsPromptActions : undefined,
          isLatestCorrectable:
            row.kind === "user" ? row.isLatestCorrectable : undefined,
          staleNowMs: row.kind === "user" ? row.staleNowMs : undefined,
        };
      }),
    ).toEqual([
      { kind: "empty", key: "turn-empty" },
      {
        kind: "user",
        key: "user-1",
        id: "user-1",
        allowsPromptActions: true,
        isLatestCorrectable: true,
        staleNowMs: Date.parse("2026-07-02T12:10:00.000Z"),
      },
      {
        kind: "user",
        key: "subagent-user-1",
        id: "subagent-user-1",
        allowsPromptActions: false,
        isLatestCorrectable: false,
        staleNowMs: undefined,
      },
      {
        kind: "standalone",
        key: "checkpoint-1",
        id: "checkpoint-1",
        allowsPromptActions: undefined,
        isLatestCorrectable: undefined,
        staleNowMs: undefined,
      },
      {
        kind: "assistant",
        key: "turn-assistant",
        firstItemId: "assistant-1",
        rows: [
          {
            kind: "item",
            id: "assistant-1",
            itemIndex: 0,
            allowsPromptActions: false,
            allowsTextQuote: true,
            allowsThinkingToggle: false,
            staleNowMs: undefined,
            thinkingDurationMs: undefined,
          },
        ],
      },
      {
        kind: "btw",
        key: "btw-aside-1",
        asideId: "aside-1",
      },
    ]);
  });

  it("filters visible turn groups for search matches", () => {
    const user1: RenderItem = {
      type: "user_prompt",
      id: "user-1",
      content: "First prompt",
      sourceMessages: [sourceMessage("user-msg-1", "2026-07-02T12:00:00Z")],
    };
    const assistant1: RenderItem = {
      type: "text",
      id: "assistant-1",
      text: "First answer",
      sourceMessages: [
        sourceMessage("assistant-msg-1", "2026-07-02T12:01:00Z"),
      ],
    };
    const user2: RenderItem = {
      type: "user_prompt",
      id: "user-2",
      content: "Second prompt",
      sourceMessages: [sourceMessage("user-msg-2", "2026-07-02T12:02:00Z")],
    };
    const read: RenderItem = {
      type: "tool_call",
      id: "read-1",
      toolName: "Read",
      toolInput: { file_path: "README.md" },
      status: "pending",
      sourceMessages: [sourceMessage("read-msg", "2026-07-02T12:03:00Z")],
    };
    const grep: RenderItem = {
      type: "tool_call",
      id: "grep-1",
      toolName: "Grep",
      toolInput: { pattern: "needle" },
      status: "pending",
      sourceMessages: [sourceMessage("grep-msg", "2026-07-02T12:04:00Z")],
    };
    const groups: RenderTurnGroup[] = [
      { isUserPrompt: true, items: [user1] },
      { isUserPrompt: false, items: [assistant1] },
      { isUserPrompt: true, items: [user2] },
      { isUserPrompt: false, items: [read, grep] },
    ];
    const groupIds = (visibleGroups: readonly RenderTurnGroup[]) =>
      visibleGroups.map((group) => group.items[0]?.id);

    expect(
      getSearchVisibleTurnGroups({
        matchIds: new Set(),
        scope: "user",
        searchReady: true,
        turnGroups: groups,
      }),
    ).toBe(groups);

    expect(
      groupIds(
        getSearchVisibleTurnGroups({
          matchIds: new Set(["user-1"]),
          scope: "user",
          searchReady: true,
          turnGroups: groups,
        }),
      ),
    ).toEqual(["user-1", "assistant-1"]);

    expect(
      groupIds(
        getSearchVisibleTurnGroups({
          matchIds: new Set(["assistant-1"]),
          scope: "all",
          searchReady: true,
          turnGroups: groups,
        }),
      ),
    ).toEqual(["assistant-1"]);

    expect(
      groupIds(
        getSearchVisibleTurnGroups({
          matchIds: new Set(["explored-read-1-grep-1:read-1"]),
          matchTargetIds: new Set(["explored-read-1-grep-1"]),
          scope: "full",
          searchReady: true,
          turnGroups: groups,
        }),
      ),
    ).toEqual(["read-1"]);
  });

  it("builds visible timeline entries from turns and btw asides", () => {
    const user: RenderItem = {
      type: "user_prompt",
      id: "user-1",
      content: "Prompt",
      sourceMessages: [sourceMessage("user-msg", "2026-07-02T12:01:00Z")],
    };
    const assistantWithoutTimestamp: RenderItem = {
      type: "text",
      id: "assistant-1",
      text: "No timestamp yet",
      sourceMessages: [],
    };
    const groups: RenderTurnGroup[] = [
      { isUserPrompt: true, items: [user] },
      { isUserPrompt: false, items: [assistantWithoutTimestamp] },
    ];
    const asides = [
      {
        id: "aside-early",
        updatedAt: "2026-07-02T12:00:00Z",
      },
      {
        id: "aside-history",
        historyAt: "2026-07-02T12:02:00Z",
        updatedAt: "2026-07-02T13:00:00Z",
      },
    ];

    const entries = buildVisibleTimelineEntries({
      asides,
      turnGroups: groups,
    });

    expect(
      entries.map((entry) =>
        entry.kind === "turn"
          ? {
              kind: entry.kind,
              key: entry.key,
              ordinal: entry.ordinal,
              timestampMs: entry.timestampMs,
              firstItemId: entry.group.items[0]?.id,
            }
          : {
              kind: entry.kind,
              key: entry.key,
              ordinal: entry.ordinal,
              timestampMs: entry.timestampMs,
              asideId: entry.aside.id,
            },
      ),
    ).toEqual([
      {
        kind: "btw",
        key: "btw-aside-early",
        ordinal: 2,
        timestampMs: Date.parse("2026-07-02T12:00:00Z"),
        asideId: "aside-early",
      },
      {
        kind: "turn",
        key: "turn-user-1",
        ordinal: 0,
        timestampMs: Date.parse("2026-07-02T12:01:00Z"),
        firstItemId: "user-1",
      },
      {
        kind: "btw",
        key: "btw-aside-history",
        ordinal: 3,
        timestampMs: Date.parse("2026-07-02T12:02:00Z"),
        asideId: "aside-history",
      },
      {
        kind: "turn",
        key: "turn-assistant-1",
        ordinal: 1,
        timestampMs: null,
        firstItemId: "assistant-1",
      },
    ]);
  });

  it("derives progressive timeline entry weights and tail counts", () => {
    const entries: ProgressiveTimelineEntry[] = [
      {
        kind: "turn" as const,
        group: { items: Array.from({ length: 30 }) },
      },
      {
        kind: "turn" as const,
        group: { items: Array.from({ length: 45 }) },
      },
      {
        kind: "turn" as const,
        group: { items: [] },
      },
      { kind: "btw" as const },
      {
        kind: "turn" as const,
        group: { items: Array.from({ length: 80 }) },
      },
      { kind: "btw" as const },
    ];

    expect(getProgressiveTimelineEntryWeight(entries[0]!)).toBe(30);
    expect(getProgressiveTimelineEntryWeight(entries[2]!)).toBe(1);
    expect(getProgressiveTimelineEntryWeight(entries[3]!)).toBe(1);
    expect(getTailEntryCountForRenderItemTarget([], 120)).toBe(0);
    expect(getTailEntryCountForRenderItemTarget(entries, 1)).toBe(1);
    expect(getTailEntryCountForRenderItemTarget(entries, 90)).toBe(5);
  });

  it("derives the next progressive timeline entry count", () => {
    const entries: ProgressiveTimelineEntry[] = [
      {
        kind: "turn" as const,
        group: { items: Array.from({ length: 30 }) },
      },
      {
        kind: "turn" as const,
        group: { items: Array.from({ length: 40 }) },
      },
      {
        kind: "turn" as const,
        group: { items: Array.from({ length: 50 }) },
      },
      { kind: "btw" as const },
    ];

    expect(getNextProgressiveEntryCount([], 1, 90)).toBe(0);
    expect(getNextProgressiveEntryCount(entries, 1, 60)).toBe(3);
    expect(getNextProgressiveEntryCount(entries, entries.length, 60)).toBe(
      entries.length,
    );
    expect(getNextProgressiveEntryCount(entries, -1, 0)).toBe(1);
  });

  it("projects progressive timeline visibility", () => {
    const entries: ProgressiveTimelineEntry[] = [
      {
        kind: "turn" as const,
        group: { items: ["one"] },
      },
      { kind: "btw" as const },
      {
        kind: "turn" as const,
        group: { items: ["two", "three"] },
      },
      { kind: "btw" as const },
    ];

    const inactive = getProgressiveTimelineVisibility({
      entries,
      entryCount: 1,
      initialEntryCount: 2,
      revealActive: false,
    });
    expect(inactive).toEqual({
      entries,
      effectiveEntryCount: entries.length,
      percent: 100,
    });
    expect(inactive.entries).toBe(entries);

    const activeInitial = getProgressiveTimelineVisibility({
      entries,
      entryCount: null,
      initialEntryCount: 2,
      revealActive: true,
    });
    expect(activeInitial.entries).toEqual(entries.slice(-2));
    expect(activeInitial.effectiveEntryCount).toBe(2);
    expect(activeInitial.percent).toBe(50);

    const activeCurrent = getProgressiveTimelineVisibility({
      entries,
      entryCount: 3,
      initialEntryCount: 2,
      revealActive: true,
    });
    expect(activeCurrent.entries).toEqual(entries.slice(-3));
    expect(activeCurrent.effectiveEntryCount).toBe(3);
    expect(activeCurrent.percent).toBe(75);
  });

  it("projects progressive timeline visibility for empty or tiny percentages", () => {
    expect(
      getProgressiveTimelineVisibility({
        entries: [],
        entryCount: 1,
        initialEntryCount: 1,
        revealActive: true,
      }),
    ).toEqual({
      entries: [],
      effectiveEntryCount: 0,
      percent: 100,
    });

    const entries = Array.from(
      { length: 1000 },
      (): ProgressiveTimelineEntry => ({ kind: "btw" }),
    );
    const projected = getProgressiveTimelineVisibility({
      entries,
      entryCount: 1,
      initialEntryCount: 1,
      revealActive: true,
    });

    expect(projected.effectiveEntryCount).toBe(1);
    expect(projected.entries).toEqual(entries.slice(-1));
    expect(projected.percent).toBe(1);
  });

  it("derives thinking duration from surrounding render item timestamps", () => {
    const thinking: RenderItem = {
      type: "thinking",
      id: "thinking-1",
      thinking: "Checking",
      status: "complete",
      sourceMessages: [
        sourceMessage("thinking-start", "2026-07-02T12:00:00.000Z"),
        sourceMessage("thinking-later", "2026-07-02T12:00:05.000Z"),
      ],
    };
    const answer: RenderItem = {
      type: "text",
      id: "answer-1",
      text: "Done",
      sourceMessages: [sourceMessage("answer", "2026-07-02T12:00:10.000Z")],
    };
    const items = [thinking, answer];

    expect(getThinkingDurationMs(thinking, items, 0, 0)).toBe(10_000);
  });

  it("derives thinking duration from own latest timestamp or streaming now", () => {
    const completeThinking: RenderItem = {
      type: "thinking",
      id: "thinking-complete",
      thinking: "Done thinking",
      status: "complete",
      sourceMessages: [
        sourceMessage("thinking-start", "2026-07-02T12:00:00.000Z"),
        sourceMessage("thinking-end", "2026-07-02T12:00:03.000Z"),
      ],
    };
    const streamingThinking: RenderItem = {
      type: "thinking",
      id: "thinking-streaming",
      thinking: "Still thinking",
      status: "streaming",
      sourceMessages: [
        sourceMessage("thinking-stream", "2026-07-02T12:01:00.000Z"),
      ],
    };

    expect(
      getThinkingDurationMs(completeThinking, [completeThinking], 0, 0),
    ).toBe(3_000);
    expect(
      getThinkingDurationMs(
        streamingThinking,
        [streamingThinking],
        0,
        Date.parse("2026-07-02T12:01:02.000Z"),
      ),
    ).toBe(2_000);
  });

  it("returns undefined for non-thinking and invalid thinking durations", () => {
    const text: RenderItem = {
      type: "text",
      id: "text-1",
      text: "Answer",
      sourceMessages: [sourceMessage("answer", "2026-07-02T12:00:00.000Z")],
    };
    const tooShort: RenderItem = {
      type: "thinking",
      id: "thinking-short",
      thinking: "Fast",
      status: "streaming",
      sourceMessages: [
        sourceMessage("thinking-short", "2026-07-02T12:00:00.000Z"),
      ],
    };
    const tooLong: RenderItem = {
      type: "thinking",
      id: "thinking-long",
      thinking: "Long",
      status: "streaming",
      sourceMessages: [
        sourceMessage("thinking-long", "2026-07-02T12:00:00.000Z"),
      ],
    };

    expect(getThinkingDurationMs(text, [text], 0, 0)).toBeUndefined();
    expect(
      getThinkingDurationMs(
        tooShort,
        [tooShort],
        0,
        Date.parse("2026-07-02T12:00:00.050Z"),
      ),
    ).toBeUndefined();
    expect(
      getThinkingDurationMs(
        tooLong,
        [tooLong],
        0,
        Date.parse("2026-07-03T12:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("derives thinking item count and latest thinking item id", () => {
    const text: RenderItem = {
      type: "text",
      id: "text-1",
      text: "Answer",
      sourceMessages: [],
    };
    const thinking1: RenderItem = {
      type: "thinking",
      id: "thinking-1",
      thinking: "First",
      status: "complete",
      sourceMessages: [],
    };
    const thinking2: RenderItem = {
      type: "thinking",
      id: "thinking-2",
      thinking: "Second",
      status: "streaming",
      sourceMessages: [],
    };
    const items = [thinking1, text, thinking2];

    expect(countThinkingItems(items)).toBe(2);
    expect(getLatestThinkingItemId(items)).toBe("thinking-2");
    expect(countThinkingItems([text])).toBe(0);
    expect(getLatestThinkingItemId([text])).toBeNull();
  });

  it("filters display render items by thinking visibility", () => {
    const text: RenderItem = {
      type: "text",
      id: "text-1",
      text: "Answer",
      sourceMessages: [],
    };
    const thinking: RenderItem = {
      type: "thinking",
      id: "thinking-1",
      thinking: "Hidden when disabled",
      status: "complete",
      sourceMessages: [],
    };
    const items = [thinking, text];

    expect(getDisplayRenderItems(items, { thinkingItemsVisible: true })).toBe(
      items,
    );
    expect(
      getDisplayRenderItems(items, { thinkingItemsVisible: false }),
    ).toEqual([text]);
  });

  it("derives thinking id and text-length summaries", () => {
    const text: RenderItem = {
      type: "text",
      id: "text-1",
      text: "Answer",
      sourceMessages: [],
    };
    const thinking1: RenderItem = {
      type: "thinking",
      id: "thinking-1",
      thinking: "First",
      status: "complete",
      sourceMessages: [],
    };
    const thinking2: RenderItem = {
      type: "thinking",
      id: "thinking-2",
      thinking: "Second thought",
      status: "streaming",
      sourceMessages: [],
    };
    const items = [thinking1, text, thinking2];

    expect(Array.from(getThinkingItemIds(items))).toEqual([
      "thinking-1",
      "thinking-2",
    ]);
    expect(Array.from(getThinkingTextLengths(items))).toEqual([
      ["thinking-1", "First".length],
      ["thinking-2", "Second thought".length],
    ]);
    expect(Array.from(getThinkingItemIds([text]))).toEqual([]);
    expect(Array.from(getThinkingTextLengths([text]))).toEqual([]);
  });

  it("detects visible thinking text deltas", () => {
    const previous = new Map([
      ["thinking-1", 5],
      ["thinking-2", 10],
    ]);
    const next = new Map([
      ["thinking-1", 6],
      ["thinking-2", 10],
      ["thinking-3", 4],
    ]);
    const expanded = new Set(["thinking-1", "thinking-3"]);
    const isThinkingItemExpanded = (itemId: string) => expanded.has(itemId);

    expect(
      hasVisibleThinkingTextDelta({
        isThinkingItemExpanded,
        nextTextLengths: next,
        previousTextLengths: previous,
        thinkingItemsVisible: true,
      }),
    ).toBe(true);
    expect(
      hasVisibleThinkingTextDelta({
        isThinkingItemExpanded,
        nextTextLengths: next,
        previousTextLengths: previous,
        thinkingItemsVisible: false,
      }),
    ).toBe(false);
    expect(
      hasVisibleThinkingTextDelta({
        isThinkingItemExpanded,
        nextTextLengths: next,
        previousTextLengths: null,
        thinkingItemsVisible: true,
      }),
    ).toBe(false);
    expect(
      hasVisibleThinkingTextDelta({
        isThinkingItemExpanded: () => false,
        nextTextLengths: next,
        previousTextLengths: previous,
        thinkingItemsVisible: true,
      }),
    ).toBe(false);
    expect(
      hasVisibleThinkingTextDelta({
        isThinkingItemExpanded: (itemId) => itemId === "thinking-3",
        nextTextLengths: next,
        previousTextLengths: previous,
        thinkingItemsVisible: true,
      }),
    ).toBe(true);
  });

  it("reconciles auto-expanded thinking ids", () => {
    const previousExpanded = new Set(["thinking-1", "stale"]);
    const current = new Set(["thinking-1", "thinking-2", "thinking-3"]);
    const observed = new Set(["thinking-1", "thinking-2"]);

    expect(
      Array.from(
        reconcileAutoExpandedThinkingItemIds({
          currentThinkingIds: current,
          previouslyObservedThinkingIds: observed,
          previousExpandedIds: previousExpanded,
          seedHistoricalThinking: false,
        }),
      ),
    ).toEqual(["thinking-1", "thinking-3"]);

    expect(
      Array.from(
        reconcileAutoExpandedThinkingItemIds({
          currentThinkingIds: current,
          previouslyObservedThinkingIds: null,
          previousExpandedIds: new Set(),
          seedHistoricalThinking: true,
        }),
      ),
    ).toEqual(["thinking-1", "thinking-2", "thinking-3"]);

    expect(
      Array.from(
        reconcileAutoExpandedThinkingItemIds({
          currentThinkingIds: current,
          previouslyObservedThinkingIds: null,
          previousExpandedIds: new Set(),
          seedHistoricalThinking: false,
        }),
      ),
    ).toEqual([]);
  });

  it("preserves auto-expanded thinking id set identity when unchanged", () => {
    const previousExpanded = new Set(["thinking-1"]);
    const reconciled = reconcileAutoExpandedThinkingItemIds({
      currentThinkingIds: new Set(["thinking-1"]),
      previouslyObservedThinkingIds: new Set(["thinking-1"]),
      previousExpandedIds: previousExpanded,
      seedHistoricalThinking: false,
    });

    expect(reconciled).toBe(previousExpanded);
  });

  it("derives search readiness, panel, active anchors, and navigator state", () => {
    const userOnlyAnchors = [{ id: "user-1", preview: "User prompt" }];
    const allTurnAnchors = [
      { id: "all-1", preview: "All turn one" },
      { id: "all-2", preview: "All turn two" },
    ];
    const fullSessionAnchors = [
      { id: "full-1", preview: "Full session result" },
    ];
    const previewsById = new Map([["all-2", "All turn two preview"]]);
    const matchIds = new Set(["all-1", "all-2"]);

    expect(getSearchReady({ active: false, query: "prompt" })).toBe(false);
    expect(getSearchReady({ active: true, query: "p" })).toBe(false);
    expect(getSearchReady({ active: true, query: " prompt " })).toBe(true);
    expect(
      hasSearchableUserTurn([
        { type: "text", id: "text-1", text: "answer", sourceMessages: [] },
      ]),
    ).toBe(false);
    expect(
      hasSearchableUserTurn([
        {
          type: "user_prompt",
          id: "user-1",
          content: "Find this",
          sourceMessages: [],
        },
      ]),
    ).toBe(true);

    expect(
      getActiveSearchAnchors({
        allAnchors: allTurnAnchors,
        fullAnchors: fullSessionAnchors,
        scope: "user",
        userAnchors: userOnlyAnchors,
      }),
    ).toBe(userOnlyAnchors);
    expect(
      getActiveSearchAnchors({
        allAnchors: allTurnAnchors,
        fullAnchors: fullSessionAnchors,
        scope: "all",
        userAnchors: userOnlyAnchors,
      }),
    ).toBe(allTurnAnchors);
    expect(
      getActiveSearchAnchors({
        allAnchors: allTurnAnchors,
        fullAnchors: fullSessionAnchors,
        scope: "full",
        userAnchors: userOnlyAnchors,
      }),
    ).toBe(fullSessionAnchors);

    expect(
      getSearchPanelProjection({
        matches: allTurnAnchors,
        scope: "all",
        searchReady: true,
        selectedId: "all-2",
      }),
    ).toEqual({
      countLabel: "2/2",
      scopeAriaLabel: "Reverse search all turns",
      scopeLabel: "All turns",
      shortcutKeys: "Ctrl+S",
    });
    expect(
      getSearchPanelProjection({
        matches: [],
        scope: "full",
        searchReady: false,
      }).countLabel,
    ).toBe("2+ chars");
    expect(
      getSearchPanelProjection({
        matches: [],
        scope: "user",
        searchReady: true,
      }).countLabel,
    ).toBe("0/0");

    expect(
      getSearchNavigatorStateProjection({
        caseSensitive: true,
        matchIds,
        preview: "All turn two preview",
        previewsById,
        query: "turn",
        searchReady: true,
        selectedAnchorId: "all-2",
      }),
    ).toEqual({
      activeId: "all-2",
      caseSensitive: true,
      matchIds,
      preview: "All turn two preview",
      previewsById,
      query: "turn",
    });
    expect(
      getSearchNavigatorStateProjection({
        matchIds,
        preview: null,
        previewsById,
        query: "",
        searchReady: false,
      }),
    ).toBeNull();
  });

  it("projects search matches, ids, selected anchor, and previews", () => {
    const anchors = [
      {
        id: "anchor-1",
        preview: "Alpha prompt",
        searchText: "Alpha prompt with repeated alpha term",
      },
      {
        id: "anchor-2",
        preview: "Explored / Read: README.md",
        searchText: "Read README.md",
        targetId: "explored-read-1-grep-1",
      },
      {
        id: "anchor-3",
        preview: "Beta prompt",
        searchText: "Beta only",
      },
    ];

    const projection = getSearchMatchProjection({
      anchors,
      query: "readme",
      searchReady: true,
    });
    const selection = getSearchSelectionProjection({
      anchors,
      previewsById: projection.previewsById,
      searchReady: true,
      selectedId: "anchor-2",
    });

    expect(projection.matches.map((anchor) => anchor.id)).toEqual(["anchor-2"]);
    expect(Array.from(projection.matchIds)).toEqual(["anchor-2"]);
    expect(Array.from(projection.matchTargetIds)).toEqual([
      "explored-read-1-grep-1",
    ]);
    expect(selection.selectedAnchor?.id).toBe("anchor-2");
    expect(selection.selectedTargetId).toBe("explored-read-1-grep-1");
    expect(selection.selectedPreview).toBe("Read README.md");
    expect(projection.previewsById.get("anchor-2")).toBe("Read README.md");
  });

  it("preserves selected active anchors even when they are not matches", () => {
    const anchors = [
      {
        id: "anchor-1",
        preview: "Alpha prompt",
        searchText: "Alpha prompt",
      },
      {
        id: "anchor-2",
        preview: "Beta prompt",
        searchText: "Beta prompt",
      },
    ];

    const projection = getSearchMatchProjection({
      anchors,
      caseSensitive: true,
      query: "alpha",
      searchReady: true,
    });
    const selection = getSearchSelectionProjection({
      anchors,
      previewsById: projection.previewsById,
      searchReady: true,
      selectedId: "anchor-2",
    });

    expect(projection.matches).toEqual([]);
    expect(selection.selectedAnchor?.id).toBe("anchor-2");
    expect(selection.selectedTargetId).toBe("anchor-2");
    expect(selection.selectedPreview).toBeNull();
    expect(projection.previewsById.size).toBe(0);
  });

  it("returns empty search projection when search is not ready", () => {
    const anchors = [
      {
        id: "anchor-1",
        preview: "Alpha prompt",
        searchText: "Alpha prompt",
      },
    ];

    const projection = getSearchMatchProjection({
      anchors,
      query: "alpha",
      searchReady: false,
    });
    const selection = getSearchSelectionProjection({
      anchors,
      previewsById: projection.previewsById,
      searchReady: false,
      selectedId: "anchor-1",
    });

    expect(projection.matches).toEqual([]);
    expect(projection.matchIds.size).toBe(0);
    expect(projection.matchTargetIds.size).toBe(0);
    expect(projection.previewsById.size).toBe(0);
    expect(selection.selectedAnchor).toBeNull();
    expect(selection.selectedTargetId).toBeNull();
    expect(selection.selectedPreview).toBeNull();
  });

  it("selects latest correctable user prompt", () => {
    const items: RenderItem[] = [
      {
        type: "user_prompt",
        id: "user-1",
        content: "Original prompt",
        sourceMessages: [],
      },
      {
        type: "text",
        id: "assistant-1",
        text: "answer",
        sourceMessages: [],
      },
      {
        type: "user_prompt",
        id: "subagent-user-1",
        content: "Subagent prompt",
        isSubagent: true,
        sourceMessages: [],
      },
      {
        type: "user_prompt",
        id: "setup",
        content:
          "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nRead CLAUDE.md\n</INSTRUCTIONS>",
        sourceMessages: [],
      },
      {
        type: "user_prompt",
        id: "user-2",
        content: [
          { type: "text", text: "Correct this prompt" },
          { type: "thinking", thinking: "not user text" },
        ],
        sourceMessages: [],
      },
    ];

    expect(selectLatestCorrectablePrompt(items)).toEqual({
      id: "user-2",
      content: "Correct this prompt",
    });
  });

  it("returns null when no prompt can be corrected", () => {
    expect(
      selectLatestCorrectablePrompt([
        {
          type: "user_prompt",
          id: "setup",
          content: "<environment_context>\n cwd\n</environment_context>",
          sourceMessages: [],
        },
        {
          type: "user_prompt",
          id: "subagent-user-1",
          content: "Subagent prompt",
          isSubagent: true,
          sourceMessages: [],
        },
      ]),
    ).toBeNull();
  });
});
