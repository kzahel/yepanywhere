// @vitest-environment jsdom

import {
  type ImagePreparationProfile,
  SERVER_CAPABILITIES,
  type StagedAttachmentRef,
} from "@yep-anywhere/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftAttachmentState } from "../../lib/draftEnvelope";
import { useComposerDraftAttachments } from "../useComposerDraftAttachments";
import type { DraftControls } from "../useDraftPersistence";

/**
 * The shared composer attachment hook's rules that no screen pin reaches
 * directly (docs/tactical/188-shared-composer-draft-attachments.md): the
 * saved files survive a write while the server's version is unknown, the
 * batch outlives its last staged file while an upload runs, and a draft key
 * change drops the uploads started for the old key.
 */

const ref = (id: string, batchId = "batch-a"): StagedAttachmentRef => ({
  id,
  batchId,
  originalName: `${id}.txt`,
  name: `${id}.txt`,
  size: 4,
  mimeType: "text/plain",
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
});

const settings = {
  imageProfile: {} as ImagePreparationProfile,
  history: null,
};

const syncVersion = {
  capabilities: [SERVER_CAPABILITIES.draftSync.name],
} as never;

function fakeControls(initial: DraftAttachmentState | null) {
  let state = initial;
  return {
    getAttachmentState: () => state,
    setAttachmentState: (next: DraftAttachmentState | null) => {
      state = next;
    },
  } as unknown as DraftControls;
}

const showToast = vi.hoisted(() => vi.fn());
vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("../../contexts/ToastContext", () => ({
  useOptionalToastContext: () => ({ showToast }),
}));

describe("useComposerDraftAttachments", () => {
  const transport = {
    fetch: vi.fn(),
    uploadStagedAttachment: vi.fn(),
  };
  // Each upload waits until the test finishes it.
  const uploads: Array<(ref: StagedAttachmentRef) => void> = [];
  const finishUpload = async (staged: StagedAttachmentRef, upload: unknown) => {
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => {
      uploads[0]?.(staged);
      await upload;
    });
  };

  beforeEach(() => {
    uploads.length = 0;
    transport.fetch.mockReset();
    transport.uploadStagedAttachment.mockReset();
    transport.uploadStagedAttachment.mockImplementation(
      () =>
        new Promise<StagedAttachmentRef>((resolve) => {
          uploads.push(resolve);
        }),
    );
  });

  afterEach(() => {
    cleanup();
  });

  function render(
    controls: DraftControls,
    initialProps: { draftKey: string; versionInfo: unknown },
  ) {
    const draftControlsRef = { current: controls };
    return renderHook(
      ({ draftKey, versionInfo }) =>
        useComposerDraftAttachments({
          draftControlsRef,
          draftKey,
          hydrationEnabled: true,
          sourceTransport: transport as never,
          versionInfo: versionInfo as never,
          versionFailed: false,
        }),
      { initialProps },
    );
  }

  it("keeps the saved file through a write made before the version is known, then checks it once", async () => {
    const saved = ref("saved");
    const controls = fakeControls({
      batchId: "batch-a",
      refs: [saved],
      updatedAt: saved.updatedAt,
    });
    const { result, rerender } = render(controls, {
      draftKey: "draft",
      versionInfo: null,
    });
    expect(result.current.attachments.map((a) => a.id)).toEqual(["saved"]);

    let upload: Promise<unknown> = Promise.resolve();
    act(() => {
      upload = result.current.uploadFiles(
        [new File(["new"], "new.txt", { type: "text/plain" })],
        settings,
      );
    });
    await finishUpload(ref("new"), upload);
    expect(controls.getAttachmentState()?.refs.map((r) => r.id)).toEqual([
      "saved",
      "new",
    ]);
    expect(transport.fetch).not.toHaveBeenCalled();

    transport.fetch.mockResolvedValue({ refs: [saved, ref("new")] });
    rerender({ draftKey: "draft", versionInfo: syncVersion });
    await waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1));
    expect(transport.fetch.mock.calls[0]?.[0]).toBe(
      "/attachments/staging/drafts/batch-a/validate",
    );
  });

  it("keeps the batch for an upload in flight when the last staged file is removed", async () => {
    const saved = ref("saved");
    const controls = fakeControls({
      batchId: "batch-a",
      refs: [saved],
      updatedAt: saved.updatedAt,
    });
    transport.fetch.mockResolvedValue({ refs: [saved] });
    const { result } = render(controls, {
      draftKey: "draft",
      versionInfo: syncVersion,
    });
    await waitFor(() =>
      expect(result.current.attachments.map((a) => a.id)).toEqual(["saved"]),
    );

    let upload: Promise<unknown> = Promise.resolve();
    act(() => {
      upload = result.current.uploadFiles(
        [new File(["new"], "new.txt", { type: "text/plain" })],
        settings,
      );
    });
    transport.fetch.mockResolvedValue({ deleted: true });
    act(() => result.current.removeAttachment("saved"));
    expect(controls.getAttachmentState()).toBeNull();
    expect(result.current.ensureDraftAttachmentBatchId()).toBe("batch-a");
    await finishUpload(ref("new"), upload);
    expect(controls.getAttachmentState()?.batchId).toBe("batch-a");
  });

  it("drops and deletes the uploads started for a draft key that changed", async () => {
    const controls = fakeControls(null);
    transport.fetch.mockResolvedValue({ deleted: true });
    const { result, rerender } = render(controls, {
      draftKey: "draft-1",
      versionInfo: syncVersion,
    });
    let upload: Promise<unknown> = Promise.resolve();
    act(() => {
      upload = result.current.uploadFiles(
        [new File(["old"], "old.txt", { type: "text/plain" })],
        settings,
      );
    });
    expect(result.current.uploadProgress).toHaveLength(1);
    rerender({ draftKey: "draft-2", versionInfo: syncVersion });
    expect(result.current.uploadProgress).toHaveLength(0);
    expect(result.current.pendingUploadsRef.current.size).toBe(0);

    await finishUpload(ref("old", "batch-old"), upload);
    expect(result.current.attachments).toEqual([]);
    expect(controls.getAttachmentState()).toBeNull();
    expect(transport.fetch).toHaveBeenCalledWith(
      "/attachments/staging/drafts/batch-old/old",
      { method: "DELETE" },
    );
  });
});
