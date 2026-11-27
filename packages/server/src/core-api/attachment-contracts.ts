import { z } from "zod";

export const MAX_API_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_API_ATTACHMENT_CHUNK_BYTES = 128 * 1024;
export const API_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
export const MAX_CALLER_ATTACHMENT_BYTES = 128 * 1024 * 1024;

export const attachmentIds = z
  .array(z.uuid())
  .min(1)
  .max(64)
  .refine((ids) => new Set(ids).size === ids.length)
  .optional()
  .describe(
    "Distinct completed attachment IDs from this caller and target project, in delivery order.",
  );

export const attachmentUploadBody = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(180)
    .regex(/^[^/\\]+$/)
    .refine(
      (name) =>
        Buffer.byteLength(name) <= 180 &&
        name.trim() !== "" &&
        [...name].every((char) => {
          const code = char.charCodeAt(0);
          return code >= 32 && code !== 127;
        }),
    )
    .describe("Filename including extension, with no directory components."),
  mimeType: z
    .string()
    .max(128)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
    .default("application/octet-stream"),
  size: z
    .int()
    .min(0)
    .max(MAX_API_ATTACHMENT_BYTES)
    .describe("Total file bytes."),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("Lowercase SHA-256 of the entire file."),
  data: z
    .string()
    .max(Math.ceil(MAX_API_ATTACHMENT_CHUNK_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .describe(
      "Standard padded base64 of this chunk. Use an empty string for an empty file.",
    ),
});

export const attachmentUploadOffset = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,7})$/)
  .describe(
    "Byte offset of this chunk. Start at 0 and use nextOffset for subsequent chunks.",
  );

export const attachmentUploadProgress = z.strictObject({
  attachmentId: z
    .uuid()
    .nullable()
    .describe("Reusable ID, available after all bytes are verified."),
  nextOffset: z.int().min(0).max(MAX_API_ATTACHMENT_BYTES),
  expiresAt: z.iso.datetime(),
});
