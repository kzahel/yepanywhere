import { createHash, randomUUID } from "node:crypto";
import * as jose from "jose";
import {
  publicKeySchema,
  privateKeySchema,
  type PublicKey,
  type PrivateKey,
  type ProfileKeys,
  type FleetControlClaims,
  type FleetPeerClaims,
  FLEET_JWT_BYTES,
} from "./contracts.js";
import { FleetError } from "./errors.js";

export const fleetDigest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function fleetOrigin(
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
    throw new FleetError(
      "invalid_issuer",
      "Fleet issuer requires an explicit HTTPS origin",
    );
  return url.origin;
}
export const publicFleetKey = (key: PrivateKey | PublicKey) =>
  publicKeySchema.parse({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
export const fleetThumbprint = (key: PublicKey) =>
  jose.calculateJwkThumbprint(key, "sha256");
export async function importFleetKey(
  key: PublicKey | PrivateKey,
  algorithm = "ES256",
) {
  const imported = await jose.importJWK(key, algorithm);
  if (imported instanceof Uint8Array)
    throw new FleetError("invalid_key", "An asymmetric fleet key is required");
  return imported;
}
export async function generateFleetPrivateKey(
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
export async function generateFleetProfileKeys(): Promise<ProfileKeys> {
  return {
    signing: await generateFleetPrivateKey(),
    encryption: await generateFleetPrivateKey("ECDH-ES"),
  };
}
export async function signFleetJwt(
  key: PrivateKey,
  payload: jose.JWTPayload,
  type: string,
): Promise<string> {
  const signed = await new jose.SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      typ: type,
      kid: await fleetThumbprint(publicFleetKey(key)),
    })
    .sign(await importFleetKey(key));
  if (Buffer.byteLength(signed) > FLEET_JWT_BYTES)
    throw new FleetError(
      "token_too_large",
      "Fleet token exceeds 32 KiB; narrow the granted scope",
    );
  return signed;
}
export const fleetControlAudience = (issuer: string) => `${issuer}/fleet/v0`;
export const fleetPeerAudience = (profileId: string) =>
  `urn:yep-anywhere:peer:${profileId}`;
export function controlPayload(
  input: Omit<FleetControlClaims, "iat" | "jti" | "aud">,
  now: number,
): FleetControlClaims {
  return {
    ...input,
    iat: Math.floor(now / 1000),
    jti: randomUUID(),
    aud: fleetControlAudience(input.iss),
  };
}
export async function verifyFleetKeyMaterial(key: PrivateKey) {
  const pub = await importFleetKey(publicFleetKey(key));
  const token = await signFleetJwt(
    key,
    { check: randomUUID() },
    "ya-key-check+jwt",
  );
  await jose.jwtVerify(token, pub, {
    algorithms: ["ES256"],
    typ: "ya-key-check+jwt",
  });
}
export async function verifyFleetPeerJwt(
  token: string,
  key: PublicKey,
  issuer: string,
  targetProfileId: string,
  now: number,
): Promise<FleetPeerClaims> {
  const { payload } = await jose.jwtVerify(token, await importFleetKey(key), {
    algorithms: ["ES256"],
    typ: "ya-peer-grant+jwt",
    issuer,
    audience: fleetPeerAudience(targetProfileId),
    currentDate: new Date(now),
    clockTolerance: 5,
    requiredClaims: ["iat", "exp", "jti", "sub"],
  });
  const { peerGrantClaimsSchema } = await import("./contracts.js");
  const claims = peerGrantClaimsSchema.parse(payload);
  const seconds = now / 1000;
  if (
    claims.iat > seconds + 5 ||
    claims.exp <= seconds ||
    claims.exp - claims.iat > 290 ||
    claims.exp <= claims.iat
  )
    throw new FleetError(
      "unauthorized",
      "Fleet peer token lifetime is invalid",
      401,
    );
  return claims;
}
