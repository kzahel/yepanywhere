import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { FleetIssuer } from "../../src/fleet/issuer.js";
import {
  fleetPeerAudience,
  fleetThumbprint,
  generateFleetPrivateKey,
  publicFleetKey,
  signFleetJwt,
} from "../../src/fleet/crypto.js";

it("coalesces configured JWKS, throttles unknown keys and refuses stale trust or private/oversized keysets", async () => {
  const first = await generateFleetPrivateKey(),
    second = await generateFleetPrivateKey();
  const issuer = "http://127.0.0.1:45678",
    targetId = randomUUID();
  let now = Date.now(),
    calls = 0,
    offline = false;
  const keys = await Promise.all(
    [first, second].map(async (key) => ({
      ...publicFleetKey(key),
      alg: "ES256",
      kid: await fleetThumbprint(publicFleetKey(key)),
    })),
  );
  let published = [keys[0]!];
  const verifier = new FleetIssuer(issuer, {
    allowInsecureLoopback: true,
    now: () => now,
    fetch: async () => {
      calls++;
      if (offline) throw new Error("owned outage");
      return Response.json({ keys: published });
    },
  });
  const token = (key = first) =>
    signFleetJwt(
      key,
      {
        iss: issuer,
        aud: fleetPeerAudience(targetId),
        sub: randomUUID(),
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 60,
        jti: randomUUID(),
        ya: {
          version: 1,
          accountId: randomUUID(),
          sourceClientId: randomUUID(),
          targetClientId: randomUUID(),
          sourceProfileId: randomUUID(),
          targetProfileId: targetId,
          sourceSigningJkt: "a".repeat(43),
          sourceEncryptionJkt: "b".repeat(43),
          relationshipId: randomUUID(),
          relationshipGeneration: 1,
          credentialId: randomUUID(),
          credentialGeneration: 1,
          policy: {
            projects: ["p"],
            operations: ["server"],
            expiresAt: now + 60_000,
          },
        },
      },
      "ya-peer-grant+jwt",
    );
  const initial = await token();
  await Promise.all(
    Array.from({ length: 8 }, () => verifier.verifyPeer(initial, targetId)),
  );
  expect(calls).toBe(1);
  await expect(
    verifier.verifyPeer(await token(second), targetId),
  ).rejects.toMatchObject({ status: 401 });
  expect(calls).toBe(1);
  now += 60_001;
  published = keys;
  await verifier.verifyPeer(await token(second), targetId);
  expect(calls).toBe(2);
  now += 600_001;
  offline = true;
  await expect(
    verifier.verifyPeer(await token(), targetId),
  ).rejects.toMatchObject({ status: 503 });
  verifier.distrust();
  const before = calls;
  await expect(
    verifier.verifyPeer(await token(), targetId),
  ).rejects.toMatchObject({ status: 401 });
  expect(calls).toBe(before);
  for (const response of [
    JSON.stringify({ keys: [{ ...keys[0], d: first.d }] }),
    " ".repeat(65_537),
  ]) {
    const invalid = new FleetIssuer(issuer, {
      allowInsecureLoopback: true,
      now: () => now,
      fetch: async () => new Response(response),
    });
    await expect(
      invalid.verifyPeer(await token(), targetId),
    ).rejects.toMatchObject({ status: 503 });
  }
});
