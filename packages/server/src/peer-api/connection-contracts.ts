import { arch, hostname, platform } from "node:os";
import { normalizeHostIdentityIcon } from "@yep-anywhere/shared";
import { z } from "zod";

export const peerHostSchema = z
  .object({
    serverId: z.uuid(),
    hostname: z.string().min(1).max(253),
    os: z.string().min(1).max(64),
    architecture: z.string().min(1).max(32),
    icon: z
      .string()
      .max(32)
      .refine((value) => normalizeHostIdentityIcon(value) !== null)
      .optional(),
  })
  .strict();
export type PeerHost = z.infer<typeof peerHostSchema>;
export function localPeerHost(serverId: string, icon?: string): PeerHost {
  return peerHostSchema.parse({
    serverId,
    hostname: hostname(),
    os: platform(),
    architecture: arch(),
    ...(icon ? { icon } : {}),
  });
}
export const peerConnectionMetadataSchema = z
  .object({
    serverId: z.uuid(),
    identity: peerHostSchema.optional(),
    label: z.string().min(1).max(128).optional(),
    setupRoute: z
      .discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("direct"), url: z.string().max(2048) })
          .strict(),
        z
          .object({
            kind: z.literal("relay"),
            url: z.string().max(2048),
            username: z.string().max(128),
          })
          .strict(),
      ])
      .optional(),
    setupUsername: z.string().max(128).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    verifiedAt: z.string().datetime().optional(),
    lastOutcome: z
      .enum(["verified", "partial", "uncertain", "failed"])
      .optional(),
  })
  .strict();
export type PeerConnectionMetadata = z.infer<
  typeof peerConnectionMetadataSchema
>;
export const peerAuditSchema = z
  .object({
    id: z.uuid(),
    at: z.string().datetime(),
    serverId: z.uuid().nullable(),
    action: z.enum([
      "pair-started",
      "incoming-issued",
      "outgoing-imported",
      "incoming-revoked",
      "outgoing-removed",
      "verified",
      "pair-completed",
      "pair-partial",
      "pair-uncertain",
      "pair-failed",
      "label-changed",
      "enabled",
      "disabled",
    ]),
    actor: z.literal("owner"),
    operationId: z.uuid().optional(),
    credentialId: z.uuid().optional(),
    generation: z.number().int().positive().optional(),
    initiatingServerId: z.uuid().optional(),
  })
  .strict();
export type PeerAudit = z.infer<typeof peerAuditSchema>;
interface PeerMetadataState {
  connections?: PeerConnectionMetadata[];
  audit?: PeerAudit[];
}
export function rememberPeer(
  state: PeerMetadataState,
  identity: PeerHost,
  label?: string,
) {
  const now = new Date().toISOString(),
    existing = state.connections?.find((p) => p.serverId === identity.serverId);
  const record = peerConnectionMetadataSchema.parse({
    ...existing,
    serverId: identity.serverId,
    identity,
    ...(label ? { label } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  const others =
    state.connections?.filter((p) => p.serverId !== identity.serverId) ?? [];
  if (others.length >= 128)
    throw new Error("Peer connection identity capacity reached");
  state.connections = [...others, record];
  return record;
}
export function recordPeerAudit(
  state: PeerMetadataState,
  action: PeerAudit["action"],
  serverId: string | null,
  initiatingServerId?: string,
  operation?: {
    operationId?: string;
    credentialId?: string;
    generation?: number;
  },
) {
  state.audit = [
    ...(state.audit ?? []),
    peerAuditSchema.parse({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action,
      serverId,
      actor: "owner",
      ...operation,
      ...(initiatingServerId ? { initiatingServerId } : {}),
    }),
  ].slice(-512);
}
