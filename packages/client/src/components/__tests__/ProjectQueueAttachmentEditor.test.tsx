// @vitest-environment jsdom

import type {
  ProjectQueueItemSummary,
  StagedAttachmentRef,
} from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ProjectQueueAttachmentEditor } from "../ProjectQueueAttachmentEditor";

/**
 * Pins what the Project Queue inline editor does with attachments before
 * docs/tactical/188-shared-composer-draft-attachments.md moves it onto the
 * shared composer attachment hook. The fake transport stands in at the
 * transport boundary, so these cases do not depend on which upload helper
 * the editor calls.
 */

const transport = vi.hoisted(() => ({
  capabilities: { sameOriginUrls: true },
  fetch: vi.fn(),
  uploadStagedAttachment: vi.fn(),
}));

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({ transport }),
}));

vi.mock("../../hooks/useProviders", () => ({
  useProviderRow: () => ({ row: undefined }),
}));

const existingRef: StagedAttachmentRef = {
  id: "existing-ref",
  batchId: "batch-a",
  originalName: "existing.txt",
  name: "existing.txt",
  size: 8,
  mimeType: "text/plain",
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
};

const item = {
  id: "item-1",
  projectId: "project-1",
  target: { type: "existing-session", sessionId: "session-abcdef" },
  messagePreview: "Queued work",
  message: {
    text: "Queued work",
    stagedAttachments: {
      batchId: "batch-a",
      refs: [existingRef],
      updatedAt: "2026-06-27T00:00:00.000Z",
    },
  },
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
  status: "queued",
  attachmentCount: 1,
} as unknown as ProjectQueueItemSummary;

const deleted = () =>
  transport.fetch.mock.calls
    .filter(([, init]) => init?.method === "DELETE")
    .map(([path]) => String(path));

function renderEditor(onSave = vi.fn(), onDiscard = vi.fn()) {
  const view = render(
    <I18nProvider>
      <ProjectQueueAttachmentEditor
        item={item}
        disabled={false}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </I18nProvider>,
  );
  return { ...view, onSave, onDiscard };
}

const paste = (name: string) =>
  fireEvent.paste(screen.getByLabelText("Project Queue message"), {
    clipboardData: {
      items: [
        {
          kind: "file",
          getAsFile: () =>
            new File([`contents of ${name}`], name, {
              type: "text/plain",
            }),
        },
      ],
    },
  });

const stagedFor = (file: File, batchId: string, id: string) => ({
  id,
  batchId,
  originalName: file.name,
  name: file.name,
  size: file.size,
  mimeType: file.type,
  createdAt: "2026-06-27T00:01:00.000Z",
  updatedAt: "2026-06-27T00:01:00.000Z",
});

describe("ProjectQueueAttachmentEditor", () => {
  beforeEach(() => {
    transport.fetch.mockReset();
    transport.fetch.mockResolvedValue({ deleted: true });
    transport.uploadStagedAttachment.mockReset();
    transport.uploadStagedAttachment.mockImplementation(
      async (file: File, options: { batchId: string }) =>
        stagedFor(file, options.batchId, `added-${file.name}`),
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("uploads an added file into the item's batch and saves it with the existing one", async () => {
    const { onSave, onDiscard } = renderEditor();
    paste("added.txt");
    await screen.findByRole("button", { name: "Remove added.txt" });
    expect(transport.uploadStagedAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "added.txt" }),
      expect.objectContaining({ batchId: "batch-a" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Queued work",
        stagedAttachments: expect.objectContaining({
          batchId: "batch-a",
          refs: [
            expect.objectContaining({ id: "existing-ref" }),
            expect.objectContaining({ id: "added-added.txt" }),
          ],
        }),
      }),
    );
    expect(deleted()).toEqual([]);
  });

  it("deletes a removed file from staging only when the editor added it", async () => {
    renderEditor();
    paste("added.txt");
    await screen.findByRole("button", { name: "Remove added.txt" });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove existing.txt" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove added.txt" }));
    await waitFor(() =>
      expect(deleted()).toEqual([
        "/attachments/staging/drafts/batch-a/added-added.txt",
      ]),
    );
  });

  it("closing without saving deletes the files it added, and only those", async () => {
    const { unmount } = renderEditor();
    paste("added.txt");
    await screen.findByRole("button", { name: "Remove added.txt" });
    unmount();
    await waitFor(() =>
      expect(deleted()).toEqual([
        "/attachments/staging/drafts/batch-a/added-added.txt",
      ]),
    );
  });

  it("drops and deletes the result of an upload removed while it ran", async () => {
    let finish: () => void = () => {};
    transport.uploadStagedAttachment.mockImplementation(
      (file: File, options: { batchId: string }) =>
        new Promise((resolve) => {
          finish = () => resolve(stagedFor(file, options.batchId, "late-ref"));
        }),
    );
    renderEditor();
    paste("late.txt");
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove late.txt" }),
    );
    expect(
      screen.queryByRole("button", { name: "Remove late.txt" }),
    ).toBeNull();
    finish();
    await waitFor(() =>
      expect(deleted()).toEqual([
        "/attachments/staging/drafts/batch-a/late-ref",
      ]),
    );
    expect(
      screen.queryByRole("button", { name: "Remove late.txt" }),
    ).toBeNull();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });
});
