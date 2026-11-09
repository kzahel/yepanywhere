// @vitest-environment jsdom

import type {
  ProjectQueueDispatchState,
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
} from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { Project } from "../../types";
import { ProjectQueueSection } from "../ProjectQueueSection";
import styles from "../ProjectQueueSection.module.css";

const attachmentMocks = vi.hoisted(() => ({
  uploadStagedAttachment: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({
    transport: {
      capabilities: { sameOriginUrls: true },
      fetch: attachmentMocks.fetch,
      uploadStagedAttachment: attachmentMocks.uploadStagedAttachment,
    },
  }),
}));

const PROJECT_ID = "project-1" as ProjectQueueItemSummary["projectId"];
const OTHER_PROJECT_ID = "project-2" as ProjectQueueItemSummary["projectId"];

const project: Project = {
  id: PROJECT_ID,
  name: "Alpha",
  path: "/tmp/alpha",
  sessionCount: 2,
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
};

const otherProject: Project = {
  id: OTHER_PROJECT_ID,
  name: "Beta",
  path: "/tmp/beta",
  sessionCount: 1,
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
};

function makeItem(
  id: string,
  status: ProjectQueueItemSummary["status"] = "queued",
  overrides: Partial<ProjectQueueItemSummary> = {},
): ProjectQueueItemSummary {
  return {
    id,
    projectId: PROJECT_ID,
    target: { type: "existing-session", sessionId: "session-abcdef" },
    messagePreview: `Queued message ${id}`,
    message: { text: `Queued message ${id}` },
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    status,
    attachmentCount: 0,
    ...(status === "failed" ? { lastError: "Provider unavailable" } : {}),
    ...overrides,
  };
}

function makeRecoveredSessionQueue(
  overrides: Partial<ProjectQueueRecoveredSessionQueueSummary> = {},
): ProjectQueueRecoveredSessionQueueSummary {
  return {
    id: "recovered-1",
    sessionId: "session-recovered",
    sessionTitle: "Recovered session",
    projectId: PROJECT_ID,
    content: "Recovered queued message",
    timestamp: "2026-06-30T00:00:00.000Z",
    queuedAt: "2026-06-30T00:00:00.000Z",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    kind: "patient",
    status: "paused-after-restart",
    ...overrides,
  };
}

function renderSection(
  items: ProjectQueueItemSummary[],
  handlers = {
    onPauseDispatch: vi.fn(),
    onResumeDispatch: vi.fn(),
    onPromoteNow: vi.fn(),
    onDeleteItem: vi.fn(),
    onResumeRecoveredItem: vi.fn(),
    onDeleteRecoveredItem: vi.fn(),
    onRetryItem: vi.fn(),
    onMoveItemToTop: vi.fn(),
    onUpdateItem: vi.fn(),
  },
  highlightedItemId?: string,
  dispatchState: ProjectQueueDispatchState = { status: "running" },
  recoveredSessionQueues: ProjectQueueRecoveredSessionQueueSummary[] = [],
  projectStatusesByProject: Record<string, ProjectQueueProjectStatus> = {},
  projects: Project[] = [project, otherProject],
  mutatingRecoveredQueueId: string | null = null,
  attachmentEditingEnabled = false,
) {
  render(
    <I18nProvider>
      <MemoryRouter>
        <ProjectQueueSection
          projects={projects}
          items={items}
          recoveredSessionQueues={recoveredSessionQueues}
          loading={false}
          error={null}
          mutatingItemId={null}
          mutatingRecoveredQueueId={mutatingRecoveredQueueId}
          mutatingDispatchState={false}
          mutatingPromoteItemId={null}
          dispatchState={dispatchState}
          projectStatusesByProject={projectStatusesByProject}
          highlightedItemId={highlightedItemId}
          attachmentEditingEnabled={attachmentEditingEnabled}
          onPauseDispatch={handlers.onPauseDispatch}
          onResumeDispatch={handlers.onResumeDispatch}
          onPromoteNow={handlers.onPromoteNow}
          onDeleteItem={handlers.onDeleteItem}
          onResumeRecoveredItem={handlers.onResumeRecoveredItem}
          onDeleteRecoveredItem={handlers.onDeleteRecoveredItem}
          onRetryItem={handlers.onRetryItem}
          onMoveItemToTop={handlers.onMoveItemToTop}
          onUpdateItem={handlers.onUpdateItem}
        />
      </MemoryRouter>
    </I18nProvider>,
  );
  return handlers;
}

function makeProjectStatus(
  state: ProjectQueueProjectStatus["state"],
  overrides: Partial<ProjectQueueProjectStatus> = {},
): ProjectQueueProjectStatus {
  const blocked = state === "blocked";
  return {
    projectId: PROJECT_ID,
    state,
    idle: !blocked,
    blockers: blocked ? ["session-abcdef:in-turn"] : [],
    dispatchPaused: state === "paused",
    inFlight: state === "dispatching",
    quietWindowMs: 30_000,
    itemCount: 1,
    nextItemId: "1",
    ...overrides,
  };
}

describe("ProjectQueueSection", () => {
  beforeEach(() => {
    attachmentMocks.uploadStagedAttachment.mockReset();
    attachmentMocks.fetch.mockReset();
    attachmentMocks.fetch.mockResolvedValue({ deleted: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders queued items with project, target, and delete action", () => {
    const handlers = renderSection([makeItem("1")]);

    expect(screen.getByRole("heading", { name: "Project Queue" })).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Queued message 1")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Session session-" })
        .getAttribute("href"),
    ).toBe("/projects/project-1/sessions/session-abcdef");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(handlers.onDeleteItem).toHaveBeenCalledWith("project-1", "1");
  });

  it("renders target session titles when available", () => {
    renderSection([
      makeItem("1", "queued", {
        targetTitle: "Investigate failing build",
        targetFullTitle: "Investigate failing build in CI",
      }),
    ]);

    expect(
      screen.getByRole("link", { name: "Investigate failing build" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Session session-" })).toBeNull();
  });

  it("shows the queued provider and model before dispatch", () => {
    renderSection([
      makeItem("1", "queued", {
        target: {
          type: "new-session",
          provider: "codex",
          model: "gpt-5.6-sol",
        },
      }),
    ]);

    expect(screen.getByRole("img", { name: "gpt-5.6-sol" })).toBeTruthy();
  });

  it("groups queued items by project name while preserving project order", () => {
    renderSection([
      makeItem("beta-1", "queued", {
        projectId: OTHER_PROJECT_ID,
        messagePreview: "Beta first queued item",
        message: { text: "Beta first queued item" },
      }),
      makeItem("alpha-1", "queued", {
        messagePreview: "Alpha queued item",
        message: { text: "Alpha queued item" },
      }),
      makeItem("beta-2", "queued", {
        projectId: OTHER_PROJECT_ID,
        messagePreview: "Beta second queued item",
        message: { text: "Beta second queued item" },
      }),
    ]);

    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Beta" })).toBeTruthy();

    const text = document.body.textContent ?? "";
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Beta"));
    expect(text.indexOf("Beta first queued item")).toBeLessThan(
      text.indexOf("Beta second queued item"),
    );
  });

  it("renders recovered session queues above project queue items", () => {
    renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      { status: "running" },
      [makeRecoveredSessionQueue()],
    );

    expect(
      screen.getByRole("heading", { name: "Paused Session Queue" }),
    ).toBeTruthy();
    expect(screen.getByText("Recovered queued message")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Recovered session" })
        .getAttribute("href"),
    ).toBe("/projects/project-1/sessions/session-recovered");

    const text = document.body.textContent ?? "";
    expect(text.indexOf("Recovered queued message")).toBeLessThan(
      text.indexOf("Queued message 1"),
    );
  });

  it("shows recovered session queues without project queue controls", () => {
    renderSection([], undefined, undefined, { status: "running" }, [
      makeRecoveredSessionQueue(),
    ]);

    expect(screen.getByText("Recovered queued message")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByText("0 queued")).toBeNull();
  });

  it("resumes and deletes the selected recovered queue row", () => {
    const handlers = renderSection(
      [],
      undefined,
      undefined,
      { status: "running" },
      [
        makeRecoveredSessionQueue(),
        makeRecoveredSessionQueue({
          id: "recovered-2",
          content: "Second recovered queued message",
        }),
      ],
    );
    const row = document.querySelector(
      '[data-recovered-queue-id="recovered-2"]',
    );
    expect(row).toBeTruthy();

    fireEvent.click(
      within(row as HTMLElement).getByRole("button", {
        name: "Resume recovered queued message",
      }),
    );
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", {
        name: "Delete recovered queued message",
      }),
    );

    expect(handlers.onResumeRecoveredItem).toHaveBeenCalledWith(
      "session-recovered",
      "recovered-2",
    );
    expect(handlers.onDeleteRecoveredItem).toHaveBeenCalledWith(
      "session-recovered",
      "recovered-2",
    );
  });

  it("disables recovered actions while a row mutation is pending", () => {
    renderSection(
      [],
      undefined,
      undefined,
      { status: "running" },
      [
        makeRecoveredSessionQueue(),
        makeRecoveredSessionQueue({ id: "recovered-2" }),
      ],
      {},
      [project],
      "recovered-2",
    );

    const busyRow = document.querySelector(
      '[data-recovered-queue-id="recovered-2"]',
    );
    expect(busyRow?.getAttribute("aria-busy")).toBe("true");
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("pauses dispatch from the header", () => {
    const handlers = renderSection([makeItem("1")]);

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(handlers.onPauseDispatch).toHaveBeenCalledTimes(1);
  });

  it("offers resume in the header and inline after a restart pause", () => {
    const handlers = renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      {
        status: "paused",
        reason: "restart",
        pausedAt: "2026-06-30T00:00:00.000Z",
      },
      [],
      { [PROJECT_ID]: makeProjectStatus("paused") },
    );

    expect(
      screen.getByText("Dispatch is paused after server restart."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /After dispatch resumes, the next item may still wait up to 30s/,
      ),
    ).toBeTruthy();
    const resumeButtons = screen.getAllByRole("button", { name: "Resume" });
    expect(resumeButtons).toHaveLength(2);
    fireEvent.click(resumeButtons[1]!);

    expect(handlers.onResumeDispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit item dispatch available while paused", () => {
    const handlers = renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      {
        status: "paused",
        reason: "restart",
        pausedAt: "2026-06-30T00:00:00.000Z",
      },
      [],
      { [PROJECT_ID]: makeProjectStatus("paused") },
    );

    fireEvent.click(screen.getByRole("button", { name: "Start now" }));

    expect(handlers.onPromoteNow).toHaveBeenCalledWith("project-1", "1", {
      force: false,
    });
  });

  it("offers retry and shows errors for failed items", () => {
    const handlers = renderSection([makeItem("2", "failed")]);

    expect(screen.getByText("Provider unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(handlers.onRetryItem).toHaveBeenCalledWith("project-1", "2");
  });

  it("offers move-to-top only for non-leading movable items", () => {
    const handlers = renderSection([makeItem("1"), makeItem("2")]);

    const moveButtons = screen.getAllByRole("button", { name: "Move to top" });
    expect(moveButtons).toHaveLength(1);
    fireEvent.click(moveButtons[0]!);

    expect(handlers.onMoveItemToTop).toHaveBeenCalledWith("project-1", "2");
  });

  it("keeps move-to-top project-local while paused", () => {
    const handlers = renderSection(
      [
        makeItem("other", "queued", { projectId: OTHER_PROJECT_ID }),
        makeItem("1"),
        makeItem("2"),
      ],
      undefined,
      undefined,
      {
        status: "paused",
        reason: "manual",
        pausedAt: "2026-06-30T00:00:00.000Z",
      },
      [],
      {
        [PROJECT_ID]: makeProjectStatus("paused"),
        [OTHER_PROJECT_ID]: makeProjectStatus("paused", {
          projectId: OTHER_PROJECT_ID,
        }),
      },
    );

    const moveButtons = screen.getAllByRole("button", { name: "Move to top" });
    expect(moveButtons).toHaveLength(1);
    fireEvent.click(moveButtons[0]!);

    expect(handlers.onMoveItemToTop).toHaveBeenCalledWith("project-1", "2");
  });

  it("starts a queued item immediately when only the quiet window remains", () => {
    const handlers = renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      { status: "running" },
      [],
      { [PROJECT_ID]: makeProjectStatus("waiting-quiet") },
    );

    expect(screen.getByText(/Waiting for project quiet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));

    expect(handlers.onPromoteNow).toHaveBeenCalledWith("project-1", "1", {
      force: false,
    });
  });

  it("surfaces a force-start override when blockers remain", () => {
    const handlers = renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      { status: "running" },
      [],
      { [PROJECT_ID]: makeProjectStatus("blocked") },
    );

    expect(
      document.querySelector(`.${styles.itemReadiness}`)?.textContent,
    ).toBe("Waiting because: session- in turn");
    fireEvent.click(screen.getByRole("button", { name: "Force start" }));

    expect(handlers.onPromoteNow).toHaveBeenCalledWith("project-1", "1", {
      force: true,
    });
  });

  it("groups same-session blockers and links the session title", () => {
    renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      { status: "running" },
      [],
      {
        [PROJECT_ID]: makeProjectStatus("blocked", {
          blockers: [
            "readiness:Waiting for readiness check",
            "01a0c5c3-full-session-id:in-turn",
            "01a0c5c3-full-session-id:liveness-verified-progressing",
          ],
          blockerSessionTitles: {
            "01a0c5c3-full-session-id": "Repair publish verification",
          },
        }),
      },
    );

    const readiness = document.querySelector(`.${styles.itemReadiness}`)!;
    expect(readiness.textContent).toBe(
      "Waiting because: Waiting for readiness check; 01a0c5c3 in turn; liveness verified-progressing; Repair publish verification",
    );
    expect(
      screen
        .getByRole("link", { name: "Repair publish verification" })
        .getAttribute("href"),
    ).toBe(`/projects/${PROJECT_ID}/sessions/01a0c5c3-full-session-id`);
  });

  it("says in words that a session's automation is paused, titled or not", () => {
    renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      { status: "running" },
      [],
      {
        [PROJECT_ID]: makeProjectStatus("blocked", {
          blockers: [
            "01a0c5c3-full-session-id:automation-paused",
            "99887766-other-session-id:automation-paused",
          ],
          blockerSessionTitles: {
            "01a0c5c3-full-session-id": "Repair publish verification",
          },
        }),
      },
    );

    expect(
      document.querySelector(`.${styles.itemReadiness}`)?.textContent,
    ).toBe(
      "Waiting because: 01a0c5c3 automation paused until your next turn; Repair publish verification; 99887766 automation paused until your next turn",
    );
  });

  it("shows the external readiness caption without interpreting its colons", () => {
    renderSection(
      [makeItem("1")],
      undefined,
      undefined,
      { status: "running" },
      [],
      {
        [PROJECT_ID]: makeProjectStatus("blocked", {
          blockers: ["readiness:Editing parser: updating tests"],
        }),
      },
    );
    expect(
      document.querySelector(`.${styles.itemReadiness}`)?.textContent,
    ).toBe("Waiting because: Editing parser: updating tests");
  });

  it("highlights a linked queue item", () => {
    renderSection([makeItem("1"), makeItem("2")], undefined, "2");

    const highlighted = document.querySelector(
      '[data-project-queue-item-id="2"]',
    );
    expect(highlighted?.className).toContain(styles.itemHighlighted);
  });

  it("edits queued item text", async () => {
    const handlers = renderSection([makeItem("4")]);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Project Queue message"), {
      target: { value: "Edited queued work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(handlers.onUpdateItem).toHaveBeenCalledWith("project-1", "4", {
        text: "Edited queued work",
      }),
    );
  });

  it("pastes and removes attachments in the capability-gated editor", async () => {
    const existingRef = {
      id: "existing-ref",
      batchId: "batch-a",
      originalName: "existing.png",
      name: "existing.png",
      size: 8,
      mimeType: "image/png",
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    };
    const handlers = renderSection(
      [
        makeItem("attachments", "queued", {
          message: {
            text: "Queued image work",
            stagedAttachments: {
              batchId: "batch-a",
              refs: [existingRef],
              updatedAt: "2026-06-27T00:00:00.000Z",
            },
          },
          attachmentCount: 1,
        }),
      ],
      undefined,
      undefined,
      { status: "running" },
      [],
      {},
      [project, otherProject],
      null,
      true,
    );
    attachmentMocks.uploadStagedAttachment.mockImplementation(
      async (file: File, { batchId }: { batchId: string }) => ({
        id: "pasted-ref",
        batchId,
        originalName: file.name,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        createdAt: "2026-06-27T00:01:00.000Z",
        updatedAt: "2026-06-27T00:01:00.000Z",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByLabelText("Project Queue message");
    const pastedImage = new File(["image"], "pasted.png", {
      type: "image/png",
    });
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => pastedImage }],
      },
    });

    await screen.findByRole("button", { name: "Remove pasted.png" });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove existing.png" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(handlers.onUpdateItem).toHaveBeenCalledWith(
        "project-1",
        "attachments",
        expect.objectContaining({
          text: "Queued image work",
          attachments: undefined,
          stagedAttachments: expect.objectContaining({
            batchId: "batch-a",
            refs: [expect.objectContaining({ id: "pasted-ref" })],
          }),
        }),
      );
      expect(attachmentMocks.fetch).not.toHaveBeenCalled();
    });
  });

  it("keeps attachment mutations disabled without the capability", async () => {
    const handlers = renderSection([
      makeItem("legacy", "queued", {
        message: {
          text: "Legacy edit",
          stagedAttachments: {
            batchId: "batch-a",
            refs: [
              {
                id: "existing-ref",
                batchId: "batch-a",
                originalName: "existing.png",
                name: "existing.png",
                size: 8,
                mimeType: "image/png",
                createdAt: "2026-06-27T00:00:00.000Z",
                updatedAt: "2026-06-27T00:00:00.000Z",
              },
            ],
            updatedAt: "2026-06-27T00:00:00.000Z",
          },
        },
        attachmentCount: 1,
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.paste(screen.getByLabelText("Project Queue message"), {
      clipboardData: {
        items: [
          {
            kind: "file",
            getAsFile: () =>
              new File(["image"], "ignored.png", { type: "image/png" }),
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(attachmentMocks.uploadStagedAttachment).not.toHaveBeenCalled();
      expect(handlers.onUpdateItem).toHaveBeenCalledWith(
        "project-1",
        "legacy",
        expect.objectContaining({
          stagedAttachments: expect.objectContaining({
            refs: [expect.objectContaining({ id: "existing-ref" })],
          }),
        }),
      );
    });
  });

  it("disables cancellation while dispatching", () => {
    renderSection([makeItem("3", "dispatching")]);

    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText("Sending")).toBeTruthy();
  });
});
