import type { ImagePreparationProfile } from "@yep-anywhere/shared";
import { prepareImageUpload } from "./imageAttachmentResize";
import type { UploadOptions } from "./transport";

/** Upload options carrying an image's dimensions, when both are known. */
export function imageDimensionOptions(
  width: number | undefined,
  height: number | undefined,
): Pick<UploadOptions, "imageDimensions"> {
  return width !== undefined && height !== undefined
    ? { imageDimensions: { width, height } }
    : {};
}

/**
 * Prepares one message-box attachment for upload: an image is resized for
 * the profile, and the options carry its dimensions and, when given, a
 * progress callback that also names the file being sent. The caller picks
 * the staged or direct upload. Shared by the upload helper the session page
 * and the Project Queue attachment editor use, and by the new-session box
 * (docs/tactical/178-shared-composer-dictation.md slice 4).
 */
export async function prepareComposerAttachmentUpload(
  file: File,
  imageProfile: ImagePreparationProfile,
  onProgress?: (bytesUploaded: number, uploadFile: File) => void,
): Promise<{ uploadFile: File; uploadOptions: UploadOptions }> {
  const preparedImage = file.type.startsWith("image/")
    ? await prepareImageUpload(file, imageProfile)
    : { file };
  const uploadFile = preparedImage.file;
  return {
    uploadFile,
    uploadOptions: {
      ...(onProgress
        ? {
            onProgress: (bytesUploaded: number) => {
              onProgress(bytesUploaded, uploadFile);
            },
          }
        : {}),
      ...imageDimensionOptions(preparedImage.width, preparedImage.height),
    },
  };
}
