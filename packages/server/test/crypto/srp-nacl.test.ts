import { describe, expect, it } from "vitest";
import {
  KEY_LENGTH,
  NONCE_LENGTH,
  decrypt,
  deriveSecretboxKey,
  encrypt,
  generateRandomKey,
} from "../../src/crypto/nacl-wrapper.js";
import { generateVerifier } from "../../src/crypto/srp-server.js";

describe("NaCl Encryption", () => {
  describe("encrypt/decrypt", () => {
    it("encrypts and decrypts correctly", () => {
      const key = generateRandomKey();
      const message = '{"type":"request","id":"123","path":"/api/sessions"}';

      const { nonce, ciphertext } = encrypt(message, key);
      const decrypted = decrypt(nonce, ciphertext, key);

      expect(decrypted).toBe(message);
    });

    it("produces different ciphertext for same message (random nonce)", () => {
      const key = generateRandomKey();
      const message = "test message";

      const result1 = encrypt(message, key);
      const result2 = encrypt(message, key);

      expect(result1.nonce).not.toBe(result2.nonce);
      expect(result1.ciphertext).not.toBe(result2.ciphertext);
    });

    it("fails with wrong key", () => {
      const key1 = generateRandomKey();
      const key2 = generateRandomKey();
      const message = "test message";

      const { nonce, ciphertext } = encrypt(message, key1);
      const decrypted = decrypt(nonce, ciphertext, key2);

      expect(decrypted).toBeNull();
    });

    it("fails with tampered ciphertext", () => {
      const key = generateRandomKey();
      const message = "test message";

      const { nonce, ciphertext } = encrypt(message, key);
      // Tamper with the ciphertext by modifying base64
      const tamperedCiphertext = `X${ciphertext.slice(1)}`;
      const decrypted = decrypt(nonce, tamperedCiphertext, key);

      expect(decrypted).toBeNull();
    });

    it("fails with wrong nonce", () => {
      const key = generateRandomKey();
      const message = "test message";

      const { ciphertext } = encrypt(message, key);
      const wrongNonce = Buffer.from(new Uint8Array(NONCE_LENGTH)).toString(
        "base64",
      );
      const decrypted = decrypt(wrongNonce, ciphertext, key);

      expect(decrypted).toBeNull();
    });

    it("throws on invalid key length", () => {
      const shortKey = new Uint8Array(16);
      expect(() => encrypt("test", shortKey)).toThrow();
    });

    it("handles empty message", () => {
      const key = generateRandomKey();
      const message = "";

      const { nonce, ciphertext } = encrypt(message, key);
      const decrypted = decrypt(nonce, ciphertext, key);

      expect(decrypted).toBe("");
    });

    it("handles unicode message", () => {
      const key = generateRandomKey();
      const message = "Hello 世界 🌍 مرحبا";

      const { nonce, ciphertext } = encrypt(message, key);
      const decrypted = decrypt(nonce, ciphertext, key);

      expect(decrypted).toBe(message);
    });

    it("handles large message", () => {
      const key = generateRandomKey();
      const message = "x".repeat(100000);

      const { nonce, ciphertext } = encrypt(message, key);
      const decrypted = decrypt(nonce, ciphertext, key);

      expect(decrypted).toBe(message);
    });
  });

  describe("deriveSecretboxKey", () => {
    it("produces 32-byte key", () => {
      const srpKey = new Uint8Array(256).fill(0x42);
      const key = deriveSecretboxKey(srpKey);
      expect(key.length).toBe(KEY_LENGTH);
    });

    it("produces consistent output for same input", () => {
      const srpKey = new Uint8Array(256).fill(0x42);
      const key1 = deriveSecretboxKey(srpKey);
      const key2 = deriveSecretboxKey(srpKey);
      expect(key1).toEqual(key2);
    });

    it("produces different output for different input", () => {
      const srpKey1 = new Uint8Array(256).fill(0x42);
      const srpKey2 = new Uint8Array(256).fill(0x43);
      const key1 = deriveSecretboxKey(srpKey1);
      const key2 = deriveSecretboxKey(srpKey2);
      expect(key1).not.toEqual(key2);
    });
  });
});

describe("SRP Authentication", () => {
  describe("generateVerifier", () => {
    it("generates salt and verifier", async () => {
      const { salt, verifier } = await generateVerifier(
        "testuser",
        "testpassword",
      );

      expect(typeof salt).toBe("string");
      expect(typeof verifier).toBe("string");
      expect(salt.length).toBeGreaterThan(0);
      expect(verifier.length).toBeGreaterThan(0);
    });

    it("generates different verifier for different password", async () => {
      const result1 = await generateVerifier("testuser", "password1");
      const result2 = await generateVerifier("testuser", "password2");

      expect(result1.verifier).not.toBe(result2.verifier);
    });

    it("generates different salt each time", async () => {
      const result1 = await generateVerifier("testuser", "testpassword");
      const result2 = await generateVerifier("testuser", "testpassword");

      expect(result1.salt).not.toBe(result2.salt);
    });
  });

  describe("Full SRP Handshake (using tssrp6a directly)", () => {
    it("both sides derive same session key", async () => {
      const username = "charlie";
      const password = "sharedpassword";

      // Generate verifier using our wrapper
      const { salt, verifier } = await generateVerifier(username, password);

      // Use tssrp6a directly to test the full handshake
      const { SRPParameters, SRPRoutines, SRPClientSession, SRPServerSession } =
        await import("tssrp6a");

      const params = new SRPParameters();
      const routines = new SRPRoutines(params);

      const saltBigInt = BigInt(`0x${salt}`);
      const verifierBigInt = BigInt(`0x${verifier}`);

      // Server step 1: Generate B
      const serverSession = new SRPServerSession(routines);
      const serverStep1 = await serverSession.step1(
        username,
        saltBigInt,
        verifierBigInt,
      );

      // Client step 1: Prepare identity hash
      const clientSession = new SRPClientSession(routines);
      const clientStep1 = await clientSession.step1(username, password);

      // Client step 2: Receive salt + B, compute A + M1
      const clientStep2 = await clientStep1.step2(saltBigInt, serverStep1.B);

      // Server step 2: Verify M1, compute M2
      const M2 = await serverStep1.step2(clientStep2.A, clientStep2.M1);
      expect(M2).toBeDefined();

      // Client step 3: Verify M2
      await clientStep2.step3(M2);

      // Get session keys from both sides
      const serverS = await serverStep1.sessionKey(clientStep2.A);
      const clientS = clientStep2.S;

      // They should be equal!
      expect(serverS).toBe(clientS);
    }, 30000);

    it("rejects wrong password", async () => {
      const username = "bob";
      const correctPassword = "correctpassword";
      const wrongPassword = "wrongpassword";

      // Setup with correct password
      const { salt, verifier } = await generateVerifier(
        username,
        correctPassword,
      );

      const { SRPParameters, SRPRoutines, SRPClientSession, SRPServerSession } =
        await import("tssrp6a");

      const params = new SRPParameters();
      const routines = new SRPRoutines(params);

      const saltBigInt = BigInt(`0x${salt}`);
      const verifierBigInt = BigInt(`0x${verifier}`);

      // Server uses correct verifier
      const serverSession = new SRPServerSession(routines);
      const serverStep1 = await serverSession.step1(
        username,
        saltBigInt,
        verifierBigInt,
      );

      // Client uses wrong password
      const clientSession = new SRPClientSession(routines);
      const clientStep1 = await clientSession.step1(username, wrongPassword);
      const clientStep2 = await clientStep1.step2(saltBigInt, serverStep1.B);

      // Server step 2 should reject invalid M1
      await expect(
        serverStep1.step2(clientStep2.A, clientStep2.M1),
      ).rejects.toThrow();
    }, 30000);
  });
});

describe("Integration: SRP + NaCl", () => {
  it("encrypts message with SRP-derived key", async () => {
    const username = "david";
    const password = "encryptiontest";

    // Generate verifier
    const { salt, verifier } = await generateVerifier(username, password);

    // Do SRP handshake
    const {
      SRPParameters,
      SRPRoutines,
      SRPClientSession,
      SRPServerSession,
      bigIntToArrayBuffer,
    } = await import("tssrp6a");

    const params = new SRPParameters();
    const routines = new SRPRoutines(params);

    const saltBigInt = BigInt(`0x${salt}`);
    const verifierBigInt = BigInt(`0x${verifier}`);

    // Complete handshake
    const serverSession = new SRPServerSession(routines);
    const serverStep1 = await serverSession.step1(
      username,
      saltBigInt,
      verifierBigInt,
    );

    const clientSession = new SRPClientSession(routines);
    const clientStep1 = await clientSession.step1(username, password);
    const clientStep2 = await clientStep1.step2(saltBigInt, serverStep1.B);

    await serverStep1.step2(clientStep2.A, clientStep2.M1);

    // Get session keys
    const serverS = await serverStep1.sessionKey(clientStep2.A);
    const clientS = clientStep2.S;

    // Derive secretbox keys from session keys
    const serverKey = deriveSecretboxKey(
      new Uint8Array(bigIntToArrayBuffer(serverS)),
    );
    const clientKey = deriveSecretboxKey(
      new Uint8Array(bigIntToArrayBuffer(clientS)),
    );

    // Encrypt with client key, decrypt with server key (simulates client -> server)
    const message =
      '{"type":"request","id":"1","method":"GET","path":"/api/test"}';
    const encrypted = encrypt(message, clientKey);
    const decrypted = decrypt(encrypted.nonce, encrypted.ciphertext, serverKey);

    expect(decrypted).toBe(message);

    // Also test server -> client direction
    const response = '{"type":"response","id":"1","status":200}';
    const encryptedResponse = encrypt(response, serverKey);
    const decryptedResponse = decrypt(
      encryptedResponse.nonce,
      encryptedResponse.ciphertext,
      clientKey,
    );

    expect(decryptedResponse).toBe(response);
  }, 30000);
});
