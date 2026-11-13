import { z } from "zod";
import { CoreApiError } from "./errors.js";

export const PEER_ENVELOPE_VERSION = "2";
export const RECEIPT_HEADER = "X-YA-Receipt";
export const httpRequestSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    contentType: z.string().max(128).optional(),
    path: z
      .string()
      .min(1)
      .max(16 * 1024),
    body: z
      .string()
      .max(256 * 1024)
      .optional(),
    key: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
  })
  .strict();
export const httpReplySchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
    body: z.string().max(2 * 1024 * 1024),
  })
  .strict();
export type ApiHttpRequest = z.infer<typeof httpRequestSchema>;
export type ApiHttpReply = z.infer<typeof httpReplySchema>;

/** One target's v0 namespace only. Reject encoding ambiguity before URL normalization. */
export function assertTargetPath(path: string, serverId: string) {
  const root = `/v0/servers/${encodeURIComponent(serverId)}`;
  const pathname = path.split("?")[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new CoreApiError("invalid_request", "Invalid path encoding", 400);
  }
  if (
    !(pathname === root || pathname.startsWith(`${root}/`)) ||
    /[\\#]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    /%2f|%5c|%25/i.test(pathname) ||
    decoded.split("/").some((part) => part === "." || part === "..") ||
    new URL(path, "http://peer.internal").pathname !== pathname
  )
    throw new CoreApiError("invalid_request", "Invalid target v0 path", 400);
}
