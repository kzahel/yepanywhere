import { z } from "zod";
import { operations } from "../core-api/contracts.js";

export const FLEET_VERSION = 1;
export const FLEET_STATE_BYTES = 8 * 1024 * 1024;
export const FLEET_JWT_BYTES = 32 * 1024;
export const FLEET_ENVELOPE_BYTES = 32 * 1024;
export const uuid = z.uuid();
export const milliseconds = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const publicKeySchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: coordinate,
    y: coordinate,
  })
  .strict();
export const privateKeySchema = publicKeySchema.extend({ d: coordinate });
export type PublicKey = z.infer<typeof publicKeySchema>;
export type PrivateKey = z.infer<typeof privateKeySchema>;
export const profileKeysSchema = z
  .object({ signing: privateKeySchema, encryption: privateKeySchema })
  .strict();
export type ProfileKeys = z.infer<typeof profileKeysSchema>;
export const clientIntroductionSchema = z
  .object({
    profileId: uuid,
    displayName: z.string().trim().min(1).max(128),
    signingKey: publicKeySchema,
    encryptionKey: publicKeySchema,
  })
  .strict();
export type ClientIntroduction = z.infer<typeof clientIntroductionSchema>;
const resourceOperations = operations
  .filter((op) => op.path.includes(":serverId"))
  .map((op) => op.id);
export const fleetPolicySchema = z
  .object({
    projects: z.array(z.string().min(1).max(4096)).max(64),
    operations: z.array(z.enum(resourceOperations)).min(1).max(32),
    expiresAt: milliseconds,
  })
  .strict()
  .refine(
    (policy) => Buffer.byteLength(JSON.stringify(policy)) <= 12 * 1024,
    "A fleet policy must fit within 12 KiB encoded JSON",
  );
export type FleetPolicy = z.infer<typeof fleetPolicySchema>;
const accountBase = z.object({
  id: uuid,
  authGeneration: z.number().int().positive(),
  enrollmentGeneration: z.number().int().positive(),
  displayName: z.string().max(128),
});
export const accountSchema = z.discriminatedUnion("kind", [
  accountBase
    .extend({
      kind: z.literal("local"),
      username: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
      passwordHash: z.string().regex(/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/),
    })
    .strict(),
  accountBase
    .extend({
      kind: z.literal("oidc"),
      issuer: z.string().url().max(2048),
      subject: z.string().min(1).max(512),
    })
    .strict(),
]);
export type FleetAccount = z.infer<typeof accountSchema>;
export const enrolledClientSchema = clientIntroductionSchema
  .extend({
    id: uuid,
    accountId: uuid,
    signingJkt: coordinate,
    encryptionJkt: coordinate,
    generation: z.literal(1),
    createdAt: milliseconds,
    revoked: z.boolean(),
  })
  .strict();
export type EnrolledClient = z.infer<typeof enrolledClientSchema>;
export const fleetSessionSchema = z
  .object({
    id: uuid,
    accountId: uuid,
    clientId: uuid,
    authGeneration: z.number().int().positive(),
    createdAt: milliseconds,
    expiresAt: milliseconds,
    refreshHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type FleetSession = z.infer<typeof fleetSessionSchema>;
export const acceptedEnvelopeSchema = z
  .object({
    envelopeId: uuid,
    credentialId: uuid,
    credentialGeneration: z.number().int().positive(),
    policy: fleetPolicySchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    acknowledged: z.boolean(),
  })
  .strict();
export const relationshipSchema = z
  .object({
    id: uuid,
    accountId: uuid,
    sourceClientId: uuid,
    targetClientId: uuid,
    generation: z.number().int().positive(),
    policy: fleetPolicySchema,
    revoked: z.boolean(),
    accepted: acceptedEnvelopeSchema.nullable(),
  })
  .strict();
export type FleetRelationship = z.infer<typeof relationshipSchema>;
export const mailboxItemSchema = z
  .object({
    id: uuid,
    relationshipId: uuid,
    generation: z.number().int().positive(),
    sourceClientId: uuid,
    targetClientId: uuid,
    expiresAt: milliseconds,
    ciphertext: z.string().max(FLEET_ENVELOPE_BYTES),
  })
  .strict();
export type MailboxItem = z.infer<typeof mailboxItemSchema>;
export const fleetStateSchema = z
  .object({
    version: z.literal(FLEET_VERSION),
    issuer: z.string().url().max(2048),
    serviceId: uuid,
    signingKey: privateKeySchema,
    previousSigningKeys: z.array(publicKeySchema).max(3),
    accounts: z.array(accountSchema).max(64),
    clients: z.array(enrolledClientSchema).max(256),
    sessions: z.array(fleetSessionSchema).max(256),
    relationships: z.array(relationshipSchema).max(1024),
    mailbox: z.array(mailboxItemSchema).max(128),
  })
  .strict();
export type FleetState = z.infer<typeof fleetStateSchema>;

export const fleetPurposes = ["enroll", "oidc", "control", "refresh"] as const;
export type FleetPurpose = (typeof fleetPurposes)[number];
export const controlClaimsSchema = z
  .object({
    iss: z.string(),
    aud: z.string(),
    sub: uuid,
    client_id: uuid,
    iat: z.number().int(),
    exp: z.number().int(),
    jti: uuid,
    cnf: z.object({ jkt: coordinate }).strict(),
    purpose: z.enum(fleetPurposes),
    profileId: uuid,
    bindingId: uuid,
    authGeneration: z.number().int().positive().optional(),
  })
  .strict();
export type FleetControlClaims = z.infer<typeof controlClaimsSchema>;
export const peerGrantClaimsSchema = z
  .object({
    iss: z.string(),
    aud: z.string(),
    sub: uuid,
    iat: z.number().int(),
    exp: z.number().int(),
    jti: uuid,
    ya: z
      .object({
        version: z.literal(1),
        accountId: uuid,
        sourceClientId: uuid,
        targetClientId: uuid,
        sourceProfileId: uuid,
        targetProfileId: uuid,
        sourceSigningJkt: coordinate,
        sourceEncryptionJkt: coordinate,
        relationshipId: uuid,
        relationshipGeneration: z.number().int().positive(),
        credentialId: uuid,
        credentialGeneration: z.number().int().positive(),
        policy: fleetPolicySchema,
      })
      .strict(),
  })
  .strict();
export type FleetPeerClaims = z.infer<typeof peerGrantClaimsSchema>;
export const fleetPageQuery = z
  .object({
    cursor: z.coerce.number().int().min(0).max(100000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export function fleetPage<T>(items: readonly T[], query: unknown) {
  const { cursor, limit } = fleetPageQuery.parse(query);
  return {
    items: items.slice(cursor, cursor + limit),
    nextCursor: cursor + limit < items.length ? String(cursor + limit) : null,
  };
}
