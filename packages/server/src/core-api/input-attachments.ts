import { constants, createReadStream } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { UploadedFile } from "@yep-anywhere/shared";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import {
  getProjectAttachmentUploadDir,
  sanitizeFilename,
} from "../uploads/manager.js";
import type { ApiAttachment } from "./attachment-uploads.js";

export async function prepareInputAttachments(
  files: readonly ApiAttachment[],
  projectPath: string,
  sessionId: string,
  storagePolicy: ProjectStoragePolicy,
  admissible: () => boolean,
) {
  const directory = await getProjectAttachmentUploadDir(
    projectPath,
    sessionId,
    storagePolicy,
  );
  const attachments: UploadedFile[] = [];
  const copied: string[] = [];
  const discard = async () => {
    await Promise.all(copied.map((path) => rm(path, { force: true })));
  };
  try {
    for (const file of files) {
      if (!admissible()) {
        await discard();
        return;
      }
      const { id, sanitized: name } = sanitizeFilename(file.originalName);
      const path = join(directory, name);
      const partial = `${path}.partial`;
      copied.push(partial);
      await copyFile(file.path, partial, constants.COPYFILE_EXCL);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(partial)) digest.update(chunk);
      if (digest.digest("hex") !== file.sha256)
        throw new Error("Staged attachment bytes changed");
      await rename(partial, path);
      copied[copied.length - 1] = path;
      attachments.push({
        id,
        name,
        path,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
      });
    }
    return { attachments, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}
