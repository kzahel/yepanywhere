import { hashPeerToken } from "./directory.js";
import { z } from "zod";

export const PEER_AUTHENTICATION = "refresh-v1" as const;
export const PEER_ACCESS_MS = 60 * 60_000;
export const PEER_IDLE_MS = 90 * 24 * 60 * 60_000;
export const PEER_REFRESH_MS = 45 * 60_000;
export const PEER_REFRESH_PATH = "/peer/v1/auth/refresh";
export const PEER_IDENTITY_PATH = "/peer/v1/auth/identity";
const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const accessHash = z.string().regex(/^[a-f0-9]{64}$/);
export const accessSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const peerRefreshRequest = z
  .object({
    requestId: z.uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    tokenHash: accessHash,
    migrationOperationId: z.uuid().optional(),
  })
  .strict();
export const peerRefreshReceipt = peerRefreshRequest
  .extend({ expiresAt: time, idleExpiresAt: time, refreshAt: time })
  .strict();
export type PeerRefreshReceipt = z.infer<typeof peerRefreshReceipt>;
export const incomingAuthentication = z
  .object({
    protocol: z.literal(PEER_AUTHENTICATION),
    lastRefreshedAt: time,
    access: z.array(peerRefreshReceipt).max(2),
  })
  .strict();
export const outgoingAuthentication = z
  .object({
    current: z
      .object({
        requestId: z.uuid(),
        sequence: z.number().int().positive(),
        token: accessSecret,
        tokenHash: accessHash,
        expiresAt: time,
        refreshAt: time,
      })
      .strict()
      .refine(
        (p) => hashPeerToken(p.token) === p.tokenHash,
        "Access secret/hash mismatch",
      )
      .optional(),
    pending: peerRefreshRequest
      .extend({ token: accessSecret, createdAt: time })
      .strict()
      .refine(
        (p) => hashPeerToken(p.token) === p.tokenHash,
        "Pending secret/hash mismatch",
      )
      .optional(),
    retryAt: time.optional(),
    failures: z.number().int().min(0).max(16).optional(),
    status: z
      .enum(["ready", "unavailable", "sign-in-required", "update-required"])
      .optional(),
    lastRefreshedAt: time.optional(),
  })
  .strict();
export type OutgoingAuthentication = z.infer<typeof outgoingAuthentication>;
