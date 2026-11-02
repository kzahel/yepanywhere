import { createHash, randomUUID } from "node:crypto";
import * as jose from "jose";
import {
  publicKeySchema,
  privateKeySchema,
  type PublicKey,
  type PrivateKey,
  type ProfileKeys,
  type IdentityServiceControlClaims,
  type IdentityServicePeerClaims,
  IDENTITY_SERVICE_JWT_BYTES,
} from "./contracts.js";
import { IdentityServiceError } from "./errors.js";

export const identityServiceDigest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function identityServiceOrigin(
  value: string,
  allowInsecureLoopback = false,
): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        allowInsecureLoopback &&
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  )
    throw new IdentityServiceError(
      "invalid_issuer",
      "Identity Service issuer requires an explicit HTTPS origin",
    );
  return url.origin;
}
export const publicIdentityServiceKey = (key: PrivateKey | PublicKey) =>
  publicKeySchema.parse({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
export const identityServiceThumbprint = (key: PublicKey) =>
  jose.calculateJwkThumbprint(key, "sha256");
export async function importIdentityServiceKey(
  key: PublicKey | PrivateKey,
  algorithm = "ES256",
) {
  const imported = await jose.importJWK(key, algorithm);
  if (imported instanceof Uint8Array)
    throw new IdentityServiceError(
      "invalid_key",
      "An asymmetric identity service key is required",
    );
  return imported;
}
export async function generateIdentityServicePrivateKey(
  algorithm = "ES256",
): Promise<PrivateKey> {
  const pair = await jose.generateKeyPair(algorithm, {
    crv: "P-256",
    extractable: true,
  });
  const exported = await jose.exportJWK(pair.privateKey);
  return privateKeySchema.parse({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
    d: exported.d,
  });
}
export async function generateIdentityServiceProfileKeys(): Promise<ProfileKeys> {
  return {
    signing: await generateIdentityServicePrivateKey(),
    encryption: await generateIdentityServicePrivateKey("ECDH-ES"),
  };
}
export async function signIdentityServiceJwt(
  key: PrivateKey,
  payload: jose.JWTPayload,
  type: string,
): Promise<string> {
  const signed = await new jose.SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      typ: type,
      kid: await identityServiceThumbprint(publicIdentityServiceKey(key)),
    })
    .sign(await importIdentityServiceKey(key));
  if (Buffer.byteLength(signed) > IDENTITY_SERVICE_JWT_BYTES)
    throw new IdentityServiceError(
      "token_too_large",
      "Identity Service token exceeds 32 KiB; narrow the granted scope",
    );
  return signed;
}
export const identityServiceControlAudience = (issuer: string) =>
  `${issuer}/fleet/v0`;
export const identityServicePeerAudience = (profileId: string) =>
  `urn:yep-anywhere:peer:${profileId}`;
export function controlPayload(
  input: Omit<IdentityServiceControlClaims, "iat" | "jti" | "aud">,
  now: number,
): IdentityServiceControlClaims {
  return {
    ...input,
    iat: Math.floor(now / 1000),
    jti: randomUUID(),
    aud: identityServiceControlAudience(input.iss),
  };
}
export async function verifyIdentityServiceKeyMaterial(key: PrivateKey) {
  const pub = await importIdentityServiceKey(publicIdentityServiceKey(key));
  const token = await signIdentityServiceJwt(
    key,
    { check: randomUUID() },
    "ya-key-check+jwt",
  );
  await jose.jwtVerify(token, pub, {
    algorithms: ["ES256"],
    typ: "ya-key-check+jwt",
  });
}
export async function verifyIdentityServicePeerJwt(
  token: string,
  key: PublicKey,
  issuer: string,
  targetProfileId: string,
  now: number,
): Promise<IdentityServicePeerClaims> {
  const { payload } = await jose.jwtVerify(
    token,
    await importIdentityServiceKey(key),
    {
      algorithms: ["ES256"],
      typ: "ya-peer-grant+jwt",
      issuer,
      audience: identityServicePeerAudience(targetProfileId),
      currentDate: new Date(now),
      clockTolerance: 5,
      requiredClaims: ["iat", "exp", "jti", "sub"],
    },
  );
  const { peerGrantClaimsSchema } = await import("./contracts.js");
  const claims = peerGrantClaimsSchema.parse(payload);
  const seconds = now / 1000;
  if (
    claims.iat > seconds + 5 ||
    claims.exp <= seconds ||
    claims.exp - claims.iat > 290 ||
    claims.exp <= claims.iat
  )
    throw new IdentityServiceError(
      "unauthorized",
      "Identity Service peer token lifetime is invalid",
      401,
    );
  return claims;
}
