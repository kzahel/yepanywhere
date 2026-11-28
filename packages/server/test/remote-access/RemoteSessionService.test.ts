import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getLogger } from "../../src/logging/logger.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../../src/crypto/nacl-wrapper.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";

describe("RemoteSessionService", () => {
  let service: RemoteSessionService;
  let testDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testDir = path.join(os.tmpdir(), `remote-session-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    service = new RemoteSessionService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    service.shutdown();
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("createSession", () => {
    it("creates a new session", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");

      const session = service.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.username).toBe("testuser");
    });

    it("stores session key correctly", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      const storedKey = service.getSessionKey(sessionId);
      expect(storedKey).not.toBeNull();
      // Compare as arrays since getSessionKey returns Buffer, not Uint8Array
      expect(Array.from(storedKey!)).toEqual(Array.from(sessionKey));
    });

    it("generates unique session IDs", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId1 = await service.createSession("user1", sessionKey);
      const sessionId2 = await service.createSession("user2", sessionKey);

      expect(sessionId1).not.toBe(sessionId2);
    });

    it("enforces max sessions per user", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);

      // Create 5 sessions (the max)
      const sessions: string[] = [];
      for (let i = 0; i < 5; i++) {
        // Small delay to ensure different lastUsed times
        await new Promise((resolve) => setTimeout(resolve, 10));
        const id = await service.createSession("testuser", sessionKey);
        sessions.push(id);
      }

      // Create a 6th session - oldest should be evicted
      const newSessionId = await service.createSession("testuser", sessionKey);

      // First session should be gone
      const [oldestSessionId] = sessions;
      assert(oldestSessionId, "Expected an oldest session to be evicted");
      expect(service.getSession(oldestSessionId)).toBeNull();

      // New session should exist
      expect(service.getSession(newSessionId)).not.toBeNull();

      // User should have exactly 5 sessions
      expect(service.getSessionCount("testuser")).toBe(5);
    });
  });

  describe("getSession", () => {
    it("returns null for non-existent session", () => {
      const session = service.getSession("nonexistent");
      expect(session).toBeNull();
    });

    it("classifies missing and expired sessions locally without changing the public refusal", async () => {
      expect(service.getResumeSessionFailure("absent")).toBe("missing_session");
      const id = await service.createSession(
        "testuser",
        new Uint8Array(32).fill(0x42),
      );
      expect(service.getResumeSessionFailure(id)).toBeNull();
      const session = service.getSession(id);
      if (!session) throw new Error("Missing fixture session");
      session.lastUsed = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      ).toISOString();
      expect(service.getResumeSessionFailure(id)).toBe("expired_session");
    });

    it("returns session for valid session ID", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      const session = service.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe(sessionId);
      expect(session?.username).toBe("testuser");
    });
  });

  describe("validateProof", () => {
    it("validates correct proof", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      // Generate a valid proof (encrypted timestamp + sessionId + challenge)
      const timestamp = Date.now();
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).not.toBeNull();
      expect(validatedSession?.sessionId).toBe(sessionId);
    });

    it("rejects proof with wrong session key", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const wrongKey = new Uint8Array(32).fill(0x43);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      // Generate proof with wrong key
      const timestamp = Date.now();
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, wrongKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
    });

    it("rejects proof with old timestamp", async () => {
      const log = vi.spyOn(getLogger(), "info").mockImplementation(() => {});
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      // Generate proof with timestamp 10 minutes ago (> 5 min max age)
      const oldTimestamp = Date.now() - 10 * 60 * 1000;
      const proofData = JSON.stringify({
        timestamp: oldTimestamp,
        sessionId,
        challenge,
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "srp_resume_refused",
          phase: "proof",
          sessionId,
          reason: "timestamp_skew",
        }),
        "SRP resume proof refused",
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(proof);
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        Buffer.from(sessionKey).toString("base64"),
      );
      log.mockRestore();
    });

    it.each([undefined, null, "now"])(
      "rejects a non-numeric proof timestamp: %s",
      async (timestamp) => {
        const key = new Uint8Array(32).fill(0x42);
        const sessionId = await service.createSession("testuser", key);
        const challenge = "test-challenge";
        const proof = JSON.stringify(
          encrypt(JSON.stringify({ timestamp, sessionId, challenge }), key),
        );
        expect(
          await service.validateProof(sessionId, proof, challenge),
        ).toBeNull();
      },
    );

    it("accepts proof within the 5 minute skew window", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      const timestamp = Date.now() - 4 * 60 * 1000;
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).not.toBeNull();
      expect(validatedSession?.sessionId).toBe(sessionId);
    });

    it("rejects proof with wrong challenge", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      const timestamp = Date.now();
      const proofData = JSON.stringify({
        timestamp,
        sessionId,
        challenge: "challenge-a",
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        "challenge-b",
      );
      expect(validatedSession).toBeNull();
    });

    it("rejects proof with mismatched sessionId in payload", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      const timestamp = Date.now();
      const proofData = JSON.stringify({
        timestamp,
        sessionId: "different-session-id",
        challenge,
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        sessionId,
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
    });

    it("rejects proof for non-existent session", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const challenge = "test-challenge";

      const timestamp = Date.now();
      const proofData = JSON.stringify({
        timestamp,
        sessionId: "nonexistent",
        challenge,
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      const validatedSession = await service.validateProof(
        "nonexistent",
        proof,
        challenge,
      );
      expect(validatedSession).toBeNull();
    });

    it("updates lastUsed on successful validation", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const challenge = "test-challenge";

      const sessionBefore = service.getSession(sessionId);
      const lastUsedBefore = sessionBefore?.lastUsed;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Validate proof
      const timestamp = Date.now();
      const proofData = JSON.stringify({ timestamp, sessionId, challenge });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      const proof = JSON.stringify({ nonce, ciphertext });

      await service.validateProof(sessionId, proof, challenge);

      const sessionAfter = service.getSession(sessionId);
      expect(sessionAfter?.lastUsed).not.toBe(lastUsedBefore);
    });
  });

  describe("deleteSession", () => {
    it("deletes an existing session", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      expect(service.getSession(sessionId)).not.toBeNull();

      await service.deleteSession(sessionId);

      expect(service.getSession(sessionId)).toBeNull();
    });

    it("handles deleting non-existent session gracefully", async () => {
      await expect(service.deleteSession("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("security client ownership", () => {
    it("binds a session once to the authenticated client", async () => {
      const sessionId = await service.createSession(
        "testuser",
        new Uint8Array(32).fill(0x42),
      );

      await expect(
        service.attachSecurityClient(sessionId, "testuser", "client-a"),
      ).resolves.toBe(true);
      await expect(
        service.attachSecurityClient(sessionId, "testuser", "client-a"),
      ).resolves.toBe(true);
      await expect(
        service.attachSecurityClient(sessionId, "testuser", "client-b"),
      ).resolves.toBe(false);
      await expect(
        service.attachSecurityClient(sessionId, "otheruser", "client-a"),
      ).resolves.toBe(false);
      expect(service.getSession(sessionId)?.securityClientId).toBe("client-a");
    });

    it("invalidates only sessions owned by the revoked client", async () => {
      const key = new Uint8Array(32).fill(0x42);
      const ownedA = await service.createSession("testuser", key);
      const ownedB = await service.createSession("testuser", key);
      const other = await service.createSession("testuser", key);
      await service.attachSecurityClient(ownedA, "testuser", "client-a");
      await service.attachSecurityClient(ownedB, "testuser", "client-a");
      await service.attachSecurityClient(other, "testuser", "client-b");

      await expect(
        service.invalidateSecurityClientSessions("client-a"),
      ).resolves.toBe(2);
      expect(service.getSession(ownedA)).toBeNull();
      expect(service.getSession(ownedB)).toBeNull();
      expect(service.getSession(other)).not.toBeNull();
    });

    it("reports the security client when the session cap evicts it", async () => {
      const evicted: Array<{ sessionId: string; securityClientId?: string }> =
        [];
      service.setEvictionListener((session) => {
        evicted.push(session);
      });
      const key = new Uint8Array(32).fill(0x42);
      const oldest = await service.createSession("testuser", key);
      await service.attachSecurityClient(oldest, "testuser", "client-a");
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        await service.createSession("testuser", key);
      }

      expect(evicted).toContainEqual(
        expect.objectContaining({
          sessionId: oldest,
          securityClientId: "client-a",
        }),
      );
    });
  });

  describe("invalidateUserSessions", () => {
    it("invalidates all sessions for a user", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);

      // Create multiple sessions for testuser
      const session1 = await service.createSession("testuser", sessionKey);
      const session2 = await service.createSession("testuser", sessionKey);

      // Create session for different user
      const otherSession = await service.createSession("otheruser", sessionKey);

      const count = await service.invalidateUserSessions("testuser");

      expect(count).toBe(2);
      expect(service.getSession(session1)).toBeNull();
      expect(service.getSession(session2)).toBeNull();
      expect(service.getSession(otherSession)).not.toBeNull();
    });

    it("returns 0 when user has no sessions", async () => {
      const count = await service.invalidateUserSessions("nonexistent");
      expect(count).toBe(0);
    });
  });

  describe("getSessionCount", () => {
    it("returns correct count for user", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);

      await service.createSession("testuser", sessionKey);
      await service.createSession("testuser", sessionKey);
      await service.createSession("otheruser", sessionKey);

      expect(service.getSessionCount("testuser")).toBe(2);
      expect(service.getSessionCount("otheruser")).toBe(1);
      expect(service.getSessionCount("nonexistent")).toBe(0);
    });
  });

  describe("persistence", () => {
    it("never writes session credentials in default in-memory mode", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);
      const filePath = path.join(testDir, "remote-sessions.json");

      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });

      const challenge = "in-memory-persistence-check";
      const proofData = JSON.stringify({
        timestamp: Date.now(),
        sessionId,
        challenge,
      });
      const { nonce, ciphertext } = encrypt(proofData, sessionKey);
      await service.validateProof(
        sessionId,
        JSON.stringify({ nonce, ciphertext }),
        challenge,
      );
      await service.updateLastConnected(sessionId);

      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });

      await service.deleteSession(sessionId);

      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });

      // Shutdown current service
      service.shutdown();

      // Create a new service instance pointing to same directory
      const newService = new RemoteSessionService({ dataDir: testDir });
      await newService.initialize();

      // Session should not exist after restart in default in-memory mode
      const session = newService.getSession(sessionId);
      expect(session).toBeNull();

      newService.shutdown();
    });

    it("persists sessions to disk when enabled", async () => {
      await service.setDiskPersistenceEnabled(true);

      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      service.shutdown();

      const newService = new RemoteSessionService({ dataDir: testDir });
      await newService.setDiskPersistenceEnabled(true);
      await newService.initialize();

      const session = newService.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.username).toBe("testuser");

      newService.shutdown();
    });

    it("deletes persisted session file when persistence is disabled", async () => {
      await service.setDiskPersistenceEnabled(true);
      await service.createSession("testuser", new Uint8Array(32).fill(0x42));

      const filePath = path.join(testDir, "remote-sessions.json");
      await expect(fs.stat(filePath)).resolves.toBeTruthy();

      await service.setDiskPersistenceEnabled(false);

      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("file permissions", () => {
    it("writes remote-sessions.json with 0600 permissions", async () => {
      if (process.platform === "win32") {
        return;
      }

      await service.setDiskPersistenceEnabled(true);
      const sessionKey = new Uint8Array(32).fill(0x42);
      await service.createSession("testuser", sessionKey);

      const filePath = path.join(testDir, "remote-sessions.json");
      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("tightens permissions on existing remote-sessions.json files at startup", async () => {
      if (process.platform === "win32") {
        return;
      }

      const filePath = path.join(testDir, "remote-sessions.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({ version: 1, sessions: {} }, null, 2),
        "utf-8",
      );
      await fs.chmod(filePath, 0o644);

      const newService = new RemoteSessionService({ dataDir: testDir });
      await newService.setDiskPersistenceEnabled(true);
      await newService.initialize();

      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);

      newService.shutdown();
    });
  });

  describe("session expiry", () => {
    it("expires sessions past max lifetime", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      // Get session and manually set createdAt to 31 days ago
      const session = service.getSession(sessionId);
      assert(session, "Expected the active session");
      session.createdAt = new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000,
      ).toISOString();

      // Now getSession should return null (expired)
      expect(service.getSession(sessionId)).toBeNull();
    });

    it("expires sessions past idle timeout", async () => {
      const sessionKey = new Uint8Array(32).fill(0x42);
      const sessionId = await service.createSession("testuser", sessionKey);

      // Get session and manually set lastUsed to 8 days ago
      const session = service.getSession(sessionId);
      assert(session, "Expected the active session");
      session.lastUsed = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      ).toISOString();

      // Now getSession should return null (expired)
      expect(service.getSession(sessionId)).toBeNull();
    });
  });
});
