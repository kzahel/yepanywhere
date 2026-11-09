import { useCallback } from "react";
import { useToastContext } from "../contexts/ToastContext";
import { useI18n } from "../i18n";
import type { resolveSessionModelConfig } from "../lib/sessionModelConfig";
import {
  getAttachmentUploadProfile,
  type useAttachmentUploadQuality,
} from "./useAttachmentUploadQuality";
import type { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import { useIncomingShareFiles } from "./useIncomingShareFiles";
import type { useProject } from "./useProjects";
import type { useSession } from "./useSession";

/**
 * One session page's uploads: picked, pasted, dropped or shared files go
 * to the shared composer attachment hook with this session's image profile
 * and composer-history context
 * (docs/tactical/188-shared-composer-draft-attachments.md).
 */
export function useSessionAttachmentUploads({
  projectId,
  sessionId,
  session,
  project,
  attachmentQuality,
  currentProviderInfo,
  effectiveModel,
  effectiveModelConfig,
  historyScope,
  isDomLingerParked,
  uploadFiles,
}: {
  projectId: string;
  sessionId: string;
  session: ReturnType<typeof useSession>["session"];
  project: ReturnType<typeof useProject>["project"];
  attachmentQuality: ReturnType<typeof useAttachmentUploadQuality>[0];
  currentProviderInfo: Parameters<typeof getAttachmentUploadProfile>[1];
  effectiveModel: string | undefined;
  effectiveModelConfig: ReturnType<typeof resolveSessionModelConfig>;
  historyScope: string | null;
  isDomLingerParked: boolean;
  uploadFiles: ReturnType<typeof useComposerDraftAttachments>["uploadFiles"];
}) {
  const { t } = useI18n();
  const { showToast } = useToastContext();

  const uploadAttachedFiles = useCallback(
    (files: File[]) =>
      uploadFiles(files, {
        imageProfile: getAttachmentUploadProfile(
          attachmentQuality,
          currentProviderInfo,
          effectiveModelConfig?.model ?? effectiveModel,
        ),
        history: historyScope
          ? {
              scope: historyScope,
              origin: {
                projectId,
                projectName: project?.name,
                sessionId,
                sessionTitle: session?.title ?? undefined,
              },
            }
          : null,
      }),
    [
      uploadFiles,
      attachmentQuality,
      currentProviderInfo,
      effectiveModelConfig?.model,
      effectiveModel,
      historyScope,
      projectId,
      project?.name,
      sessionId,
      session?.title,
    ],
  );

  const handleAttach = useCallback(
    async (files: File[]) => {
      await uploadAttachedFiles(files);
    },
    [uploadAttachedFiles],
  );

  useIncomingShareFiles(handleAttach, {
    enabled: !isDomLingerParked,
    onError: () => showToast(t("incomingShareAttachmentUnavailable"), "error"),
  });

  return { uploadAttachedFiles, handleAttach };
}
