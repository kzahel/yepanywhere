import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SRPClientSession,
  SRPParameters,
  SRPRoutines,
  SRPServerSession,
  bigIntToArrayBuffer,
} from "tssrp6a";
import nacl from "tweetnacl";
import {
  deriveSecretboxKey,
  deriveTransportKey,
} from "../packages/server/src/crypto/nacl-wrapper.js";
import {
  BinaryFormat,
  createBinaryEnvelope,
  prependFormatByte,
} from "../packages/shared/src/binary-framing.js";

const FIXTURE_PATH = resolve(
  "packages/android/app/src/sharedTest/resources/ya-secure-interop-v1.json",
);

const utf8 = new TextEncoder();

class FixedPrivateRoutines extends SRPRoutines {
  constructor(
    parameters: SRPParameters,
    private readonly privateValue: bigint,
  ) {
    super(parameters);
  }

  override generatePrivateValue(): bigint {
    return this.privateValue;
  }
}

function hex(value: bigint): string {
  return value.toString(16);
}

function bytesHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function base64(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  return Buffer.from(bytes).toString("base64");
}

function rangeBytes(start: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
}

function encryptFixed(
  plaintext: string,
  key: Uint8Array,
  nonce: Uint8Array,
): { nonce: string; ciphertext: string } {
  return {
    nonce: base64(nonce),
    ciphertext: base64(nacl.secretbox(utf8.encode(plaintext), nonce, key)),
  };
}

export async function createFixture(
  options: {
    password?: string;
    salt?: bigint;
    clientPrivate?: bigint;
    serverPrivate?: bigint;
  } = {},
) {
  const parameters = new SRPParameters();
  const referenceRoutines = new SRPRoutines(parameters);
  const username = "android-native-interop";
  const password = options.password ?? "correct horse battery staple";
  const salt =
    options.salt ??
    BigInt(
      "0x00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f",
    );
  const clientPrivate =
    options.clientPrivate ??
    BigInt(
      "0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100",
    );
  const serverPrivate =
    options.serverPrivate ??
    BigInt(
      "0x202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
    );

  const x = await referenceRoutines.computeX(username, salt, password);
  const verifier = referenceRoutines.computeVerifier(x);
  const clientRoutines = new FixedPrivateRoutines(parameters, clientPrivate);
  const serverRoutines = new FixedPrivateRoutines(parameters, serverPrivate);
  const clientStep1 = await new SRPClientSession(clientRoutines).step1(
    username,
    password,
  );
  const serverStep1 = await new SRPServerSession(serverRoutines).step1(
    username,
    salt,
    verifier,
  );
  const clientStep2 = await clientStep1.step2(salt, serverStep1.B);
  const serverM2 = await serverStep1.step2(clientStep2.A, clientStep2.M1);
  await clientStep2.step3(serverM2);
  const serverSessionKey = await serverStep1.sessionKey(clientStep2.A);
  if (serverSessionKey !== clientStep2.S) {
    throw new Error("Deterministic SRP client/server session keys differ");
  }

  const k = await referenceRoutines.computeK();
  const u = await referenceRoutines.computeU(clientStep2.A, serverStep1.B);
  const rawSessionKey = new Uint8Array(bigIntToArrayBuffer(clientStep2.S));
  const baseKey = deriveSecretboxKey(rawSessionKey);
  const transportNonce = rangeBytes(0x40, 24);
  const transportKey = deriveTransportKey(baseKey, base64(transportNonce));
  const sessionId = "android-native-interop-session";

  const serverInfoPlaintext = JSON.stringify({
    type: "srp_verify_server_info",
    sessionId,
    transportNonce: base64(transportNonce),
    resumeProtocolVersion: 3,
  });
  const serverInfoProof = encryptFixed(
    serverInfoPlaintext,
    baseKey,
    rangeBytes(0x60, 24),
  );

  const encryptedMessagePlaintext = JSON.stringify({
    seq: 0,
    msg: { type: "ping", id: "android-native-interop-ping" },
  });
  const encryptedMessageInner = prependFormatByte(
    BinaryFormat.JSON,
    utf8.encode(encryptedMessagePlaintext),
  );
  const encryptedMessageNonce = rangeBytes(0x80, 24);
  const encryptedMessageCiphertext = nacl.secretbox(
    encryptedMessageInner,
    encryptedMessageNonce,
    transportKey,
  );
  const encryptedMessageEnvelope = createBinaryEnvelope(
    encryptedMessageNonce,
    encryptedMessageCiphertext,
  );

  const resumeClientNonce = rangeBytes(0xa0, 24);
  const resumeServerNonce = rangeBytes(0xc0, 24);
  const resumeProofPlaintext = JSON.stringify({
    timestamp: 1_800_000_000_000,
    challenge: base64(resumeServerNonce),
    sessionId,
  });
  const resumeProof = encryptFixed(
    resumeProofPlaintext,
    baseKey,
    rangeBytes(0xe0, 24),
  );
  const resumeServerProofPlaintext = JSON.stringify({
    type: "srp_resume_server_proof",
    sessionId,
    serverNonce: base64(resumeServerNonce),
    clientNonce: base64(resumeClientNonce),
    resumeProtocolVersion: 3,
  });
  const resumeServerProof = encryptFixed(
    resumeServerProofPlaintext,
    baseKey,
    rangeBytes(0x10, 24),
  );
  const resumedTransportKey = deriveTransportKey(
    baseKey,
    base64(resumeServerNonce),
  );

  return {
    schemaVersion: 1,
    source: "tssrp6a@3.0.0 + tweetnacl@1.0.3",
    srp: {
      groupBits: parameters.NBits,
      hash: "SHA-512",
      N: hex(parameters.primeGroup.N),
      g: hex(parameters.primeGroup.g),
      username,
      password,
      salt: hex(salt),
      clientPrivate: hex(clientPrivate),
      serverPrivate: hex(serverPrivate),
      x: hex(x),
      verifier: hex(verifier),
      k: hex(k),
      u: hex(u),
      A: hex(clientStep2.A),
      B: hex(serverStep1.B),
      S: hex(clientStep2.S),
      M1: hex(clientStep2.M1),
      M2: hex(serverM2),
      rawSessionKeyHex: bytesHex(rawSessionKey),
      baseKeyHex: bytesHex(baseKey),
    },
    fullSession: {
      sessionId,
      transportNonce: base64(transportNonce),
      transportKeyHex: bytesHex(transportKey),
      serverInfoPlaintext,
      serverInfoProof,
    },
    binaryEnvelope: {
      format: BinaryFormat.JSON,
      plaintext: encryptedMessagePlaintext,
      nonce: base64(encryptedMessageNonce),
      envelopeBase64: base64(encryptedMessageEnvelope),
    },
    resume: {
      clientNonce: base64(resumeClientNonce),
      serverNonce: base64(resumeServerNonce),
      proofPlaintext: resumeProofPlaintext,
      proof: resumeProof,
      serverProofPlaintext: resumeServerProofPlaintext,
      serverProof: resumeServerProof,
      transportKeyHex: bytesHex(resumedTransportKey),
    },
  };
}

async function main(): Promise<void> {
  const expected = `${JSON.stringify(await createFixture(), null, 2)}\n`;
  if (process.argv.includes("--write")) {
    await writeFile(FIXTURE_PATH, expected, "utf8");
    console.log(`Wrote ${FIXTURE_PATH}`);
    return;
  }

  const actual = await readFile(FIXTURE_PATH, "utf8").catch(() => "");
  if (actual !== expected) {
    throw new Error(
      `Android secure interop fixture is stale; run "pnpm android:interop:write"`,
    );
  }
  console.log(
    "Android secure interop fixture matches production TypeScript crypto",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
