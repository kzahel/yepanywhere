import type { StagedAttachmentRef, UploadedFile } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SourceTransport } from "../transport";
import {
  appendComposerTransferDraft,
  appendSlashCommandDraft,
  collectComposerAttachmentsForSubmission,
  ComposerAttachmentUploadError,
  createComposerDraftAttachmentState,
  getComposerTransferReplacement,
  hasComposerDraftContent,
  insertComposerTransferText,
  materializeComposerAttachmentsForSubmission,
  splitComposerAttachmentsForSubmission,
  stageComposerAttachmentsForNewSession,
  uploadComposerAttachmentFile,
} from "../sessionComposerSubmission";
import type { ComposerAttachment } from "../sessionComposerAttachments";

const stagedRef: StagedAttachmentRef = {
  id: "staged-a",
  batchId: "batch-a",
  originalName: "draft.png",
  name: "uuid_draft.png",
  size: 123,
  mimeType: "image/png",
  width: 320,
  height: 240,
  createdAt: "2026-07-06T10:00:00.000Z",
  updatedAt: "2026-07-06T10:00:01.000Z",
};

const uploadedFile: UploadedFile = {
  id: "uploaded-a",
  originalName: "notes.txt",
  name: "uuid_notes.txt",
  path: "/uploads/uuid_notes.txt",
  size: 12,
  mimeType: "text/plain",
};

describe("session composer submission helpers", () => {
  it("copies original session bytes into staging before delivery to another project", async () => {
    const name = "11111111-1111-1111-1111-111111111111_notes.txt";
    const source = {
      ...uploadedFile,
      name,
      path: `/data/projects/key/attachments/source-session/${name}`,
    };
    const fetchBlob = vi.fn().mockResolvedValue(new Blob(["original bytes"]));
    const uploadStagedAttachment = vi.fn().mockResolvedValue({
      ...stagedRef,
      id: "copy",
      originalName: "notes.txt",
    });
    const destination = {
      ...uploadedFile,
      path: "/data/projects/destination/attachments/new-session/copied.txt",
    };
    const fetch = vi.fn().mockResolvedValue({ files: [destination] });
    const attachments = await stageComposerAttachmentsForNewSession({
      attachments: [source, stagedRef],
      sourceTransport: { fetchBlob, uploadStagedAttachment },
      sourceProjectId: "source-project",
    });
    expect(fetchBlob).toHaveBeenCalledWith(
      `/projects/source-project/sessions/source-session/upload/${name}`,
    );
    const file = uploadStagedAttachment.mock.calls[0]?.[0] as File;
    expect(file.name).toBe("notes.txt");
    expect(
      await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(file);
      }),
    ).toBe("original bytes");
    expect(uploadStagedAttachment).toHaveBeenCalledWith(file, {
      batchId: "batch-a",
    });
    expect(attachments[1]).toBe(stagedRef);
    expect(
      await materializeComposerAttachmentsForSubmission({
        attachments,
        sourceTransport: { fetch },
        projectId: "destination",
        sessionId: "new-session",
      }),
    ).toEqual([destination]);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/projects/destination/sessions/new-session/attachments/staging/materialize",
    );
    fetchBlob.mockRejectedValueOnce(new Error("Source unavailable"));
    await expect(
      stageComposerAttachmentsForNewSession({
        attachments: [source],
        sourceTransport: { fetchBlob, uploadStagedAttachment },
        sourceProjectId: "source-project",
      }),
    ).rejects.toThrow("Source unavailable");
    expect(uploadStagedAttachment).toHaveBeenCalledTimes(1);
  });

  it("counts completed and pending attachments as draft content", () => {
    expect(hasComposerDraftContent("", 0)).toBe(false);
    expect(hasComposerDraftContent("  ", 0)).toBe(false);
    expect(hasComposerDraftContent("message", 0)).toBe(true);
    expect(hasComposerDraftContent("", 1)).toBe(true);
  });

  it("builds transfer and slash-command draft text without changing spacing rules", () => {
    expect(
      getComposerTransferReplacement(" existing  ", "  addition "),
    ).toEqual({
      start: 9,
      end: 11,
      replacement: "\n\naddition",
      nextDraft: " existing\n\naddition",
    });

    expect(appendComposerTransferDraft("", "  addition ")).toBe("addition");
    expect(appendSlashCommandDraft("/mo", "model")).toBe("/model ");
    expect(appendSlashCommandDraft("hello", "/fast")).toBe("hello /fast ");
  });

  it("inserts transfer text through the undoable range edit when mounted", () => {
    const setDraft = vi.fn();
    const replaceDraftRangeUndoably = vi.fn(
      (start: number, end: number, replacement: string) =>
        `typed ${start}-${end}${replacement}`,
    );

    expect(
      insertComposerTransferText(
        { getDraft: () => "typed ", setDraft, replaceDraftRangeUndoably },
        "> quote",
        "\n",
      ),
    ).toBe("typed 5-6\n\n> quote\n");
    expect(replaceDraftRangeUndoably).toHaveBeenCalledWith(
      5,
      6,
      "\n\n> quote\n",
    );
    expect(setDraft).not.toHaveBeenCalled();

    const unmountedSetDraft = vi.fn();
    expect(
      insertComposerTransferText(
        {
          getDraft: () => "typed",
          setDraft: unmountedSetDraft,
          replaceDraftRangeUndoably: () => null,
        },
        "prompt",
      ),
    ).toBe("typed\n\nprompt");
    expect(unmountedSetDraft).toHaveBeenCalledWith("typed\n\nprompt");
  });

  it("preserves each attachment's batch when a draft combines uploads", () => {
    const withPreview = { ...stagedRef, previewUrl: "blob:draft" };

    expect(
      createComposerDraftAttachmentState([uploadedFile, withPreview], "now"),
    ).toEqual({
      batchId: "batch-a",
      refs: [stagedRef],
      updatedAt: "now",
    });
    expect(
      createComposerDraftAttachmentState([uploadedFile], "now"),
    ).toBeNull();
    expect(
      splitComposerAttachmentsForSubmission([
        stagedRef,
        { ...stagedRef, id: "staged-b", batchId: "batch-b" },
      ]),
    ).toMatchObject({
      uploadedFiles: [],
      draftState: {
        batchId: "batch-a",
        refs: [stagedRef, { ...stagedRef, id: "staged-b", batchId: "batch-b" }],
      },
    });
  });

  it("collects pending uploads and clears composer attachments around submission", async () => {
    const setComposerAttachments = vi.fn();
    const updatePendingMessage = vi.fn();
    const pendingAttachment: ComposerAttachment = {
      ...uploadedFile,
      id: "pending-upload",
    };

    await expect(
      collectComposerAttachmentsForSubmission({
        currentAttachments: [uploadedFile],
        pendingUploads: [Promise.resolve(pendingAttachment)],
        setComposerAttachments,
        pendingMessageId: "temp-a",
        updatePendingMessage,
        uploadingStatus: "Uploading",
      }),
    ).resolves.toEqual([uploadedFile, pendingAttachment]);

    expect(updatePendingMessage).toHaveBeenNthCalledWith(1, "temp-a", {
      status: "Uploading",
    });
    expect(setComposerAttachments).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      {
        persistDraft: false,
      },
    );
    expect(setComposerAttachments).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      { persistDraft: false },
    );
    expect(updatePendingMessage).toHaveBeenLastCalledWith("temp-a", {
      status: undefined,
    });
  });

  it("keeps canonical collected files attached through mixed upload failure and newer selections", async () => {
    const successful = { ...stagedRef, id: "successful" };
    const newer = { ...stagedRef, id: "newer" };
    let live: ComposerAttachment[] = [uploadedFile];
    const detach = vi.fn(
      (
        updater:
          | ComposerAttachment[]
          | ((previous: readonly ComposerAttachment[]) => ComposerAttachment[]),
      ) => {
        live = typeof updater === "function" ? updater(live) : updater;
      },
    );
    let finish!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      finish = resolve;
    });
    const result = collectComposerAttachmentsForSubmission({
      detach: false,
      currentAttachments: live,
      pendingUploads: [Promise.resolve(successful), pending],
      setComposerAttachments: detach,
    }).catch((error) => error);
    live = [...live, successful, newer];
    finish(null);
    const failure = await result;
    expect(failure).toBeInstanceOf(ComposerAttachmentUploadError);
    expect(failure.attachments).toEqual([uploadedFile, successful]);
    expect(live).toEqual([uploadedFile, successful, newer]);
    expect(detach).not.toHaveBeenCalled();
  });

  it("refuses partial delivery when a pending upload fails, retaining successful attachments for recovery", async () => {
    const pending = { ...stagedRef, id: "successful-pending" };
    const failure = await collectComposerAttachmentsForSubmission({
      currentAttachments: [uploadedFile],
      pendingUploads: [Promise.resolve(pending), Promise.resolve(null)],
      setComposerAttachments: vi.fn(),
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ComposerAttachmentUploadError);
    expect(failure.attachments).toEqual([uploadedFile, pending]);
  });

  it("materializes staged refs after preserving already uploaded files", async () => {
    const materializedFile: UploadedFile = {
      ...uploadedFile,
      id: "materialized-a",
    };
    const sourceTransport = {
      fetch: vi.fn().mockResolvedValue({ files: [materializedFile] }),
    } as unknown as Pick<SourceTransport, "fetch">;

    await expect(
      materializeComposerAttachmentsForSubmission({
        attachments: [uploadedFile, stagedRef],
        sourceTransport,
        projectId: "project-a",
        sessionId: "session/a",
      }),
    ).resolves.toEqual([uploadedFile, materializedFile]);

    expect(sourceTransport.fetch).toHaveBeenCalledWith(
      "/projects/project-a/sessions/session%2Fa/attachments/staging/materialize",
      {
        method: "POST",
        body: JSON.stringify({ batchId: "batch-a", refs: [stagedRef] }),
      },
    );
  });

  it("uploads direct and staged composer files with progress callbacks", async () => {
    const directFile = new File(["hello"], "notes.txt", {
      type: "text/plain",
    });
    const imageFile = new File(["image"], "image.png", { type: "image/png" });
    const upload = vi.fn(async (_projectId, _sessionId, file, options) => {
      options?.onProgress?.(file.size);
      return { ...uploadedFile, size: file.size };
    });
    const uploadStagedAttachment = vi.fn(async (file, options) => {
      options?.onProgress?.(file.size);
      return { ...stagedRef, size: file.size };
    });
    const sourceTransport = {
      upload,
      uploadStagedAttachment,
    } as unknown as Pick<SourceTransport, "upload" | "uploadStagedAttachment">;
    const progress = vi.fn();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:image-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    try {
      await expect(
        uploadComposerAttachmentFile({
          file: directFile,
          sourceTransport,
          projectId: "project-a",
          sessionId: "session-a",
          imageProfile: {
            maxLongEdge: 2000,
            maxBytes: 4 * 1024 * 1024,
            quality: 90,
          },
          onProgress: progress,
        }),
      ).resolves.toMatchObject({ id: "uploaded-a", size: directFile.size });

      await expect(
        uploadComposerAttachmentFile({
          file: imageFile,
          sourceTransport,
          projectId: "project-a",
          sessionId: "session-a",
          imageProfile: {
            maxLongEdge: 2000,
            maxBytes: 4 * 1024 * 1024,
            quality: 90,
          },
          stagedBatchId: "batch-a",
          onProgress: progress,
        }),
      ).resolves.toMatchObject({
        id: "staged-a",
        previewUrl: "blob:image-preview",
      });

      expect(sourceTransport.upload).toHaveBeenCalledWith(
        "project-a",
        "session-a",
        directFile,
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      expect(sourceTransport.uploadStagedAttachment).toHaveBeenCalledWith(
        imageFile,
        expect.objectContaining({
          batchId: "batch-a",
          onProgress: expect.any(Function),
        }),
      );
      expect(progress).toHaveBeenCalledWith(directFile.size, directFile);
      expect(progress).toHaveBeenCalledWith(imageFile.size, imageFile);

      uploadStagedAttachment.mockRejectedValueOnce(new Error("boom"));
      await expect(
        uploadComposerAttachmentFile({
          file: imageFile,
          sourceTransport,
          projectId: "project-a",
          sessionId: "session-a",
          imageProfile: {
            maxLongEdge: 2000,
            maxBytes: 4 * 1024 * 1024,
            quality: 90,
          },
          stagedBatchId: "batch-a",
        }),
      ).rejects.toThrow("boom");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image-preview");
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    }
  });
});
