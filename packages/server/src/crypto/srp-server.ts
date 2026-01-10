/**
 * SRP-6a server helpers for remote access authentication.
 *
 * Uses tssrp6a library with 2048-bit prime group and SHA-256.
 */
import {
  SRPParameters,
  SRPRoutines,
  SRPServerSession,
  type SRPServerSessionStep1,
  bigIntToArrayBuffer,
  createVerifierAndSalt,
} from "tssrp6a";

/** SRP parameters: 2048-bit prime group with SHA-256 */
const SRP_PARAMS = new SRPParameters();
const SRP_ROUTINES = new SRPRoutines(SRP_PARAMS);

/**
 * Convert bigint to hex string.
 */
function bigIntToHex(n: bigint): string {
  return n.toString(16);
}

/**
 * Convert hex string to bigint.
 */
function hexToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/**
 * Generate salt and verifier for a username/password.
 * Store the returned values - never store the password.
 *
 * @param username - User identity
 * @param password - User password (not stored)
 * @returns Object with hex-encoded salt and verifier
 */
export async function generateVerifier(
  username: string,
  password: string,
): Promise<{ salt: string; verifier: string }> {
  const { s, v } = await createVerifierAndSalt(
    SRP_ROUTINES,
    username,
    password,
  );
  return {
    salt: bigIntToHex(s),
    verifier: bigIntToHex(v),
  };
}

/**
 * Server SRP session wrapper for WebSocket authentication.
 *
 * Usage:
 * 1. Create session: `new SrpServerSession()`
 * 2. Generate challenge: `session.generateChallenge(identity, salt, verifier)` → returns B
 * 3. Verify proof: `session.verifyProof(clientA, clientM1)` → returns M2 or null
 * 4. Get key: `session.getSessionKey()` → returns raw session key bytes
 */
export class SrpServerSession {
  private session: SRPServerSession;
  private step1Result: SRPServerSessionStep1 | null = null;
  private sessionKey: Uint8Array | null = null;

  constructor() {
    this.session = new SRPServerSession(SRP_ROUTINES);
  }

  /**
   * Generate server challenge (step 1).
   * Call this after receiving the client's identity.
   *
   * @param identity - Username from client
   * @param salt - Stored salt for this user (hex string)
   * @param verifier - Stored verifier for this user (hex string)
   * @returns Server public value B (hex string)
   */
  async generateChallenge(
    identity: string,
    salt: string,
    verifier: string,
  ): Promise<{ B: string }> {
    const saltBigInt = hexToBigInt(salt);
    const verifierBigInt = hexToBigInt(verifier);

    // Step 1: Generate server's ephemeral values (doesn't need client A yet)
    this.step1Result = await this.session.step1(
      identity,
      saltBigInt,
      verifierBigInt,
    );

    return { B: bigIntToHex(this.step1Result.B) };
  }

  /**
   * Verify client proof (step 2).
   * Call this after receiving A and M1 from the client.
   *
   * @param clientA - Client public value A (hex string)
   * @param clientM1 - Client proof M1 (hex string)
   * @returns Server proof M2 (hex string) if valid, null if invalid
   */
  async verifyProof(
    clientA: string,
    clientM1: string,
  ): Promise<{ M2: string } | null> {
    if (!this.step1Result) {
      throw new Error("Must call generateChallenge before verifyProof");
    }

    const A = hexToBigInt(clientA);
    const M1 = hexToBigInt(clientM1);

    try {
      // Step 2: Verify client proof and generate server proof
      const M2 = await this.step1Result.step2(A, M1);

      // Derive session key
      const S = await this.step1Result.sessionKey(A);
      const keyBuffer = bigIntToArrayBuffer(S);
      this.sessionKey = new Uint8Array(keyBuffer);

      return { M2: bigIntToHex(M2) };
    } catch {
      // Invalid proof - authentication failed
      return null;
    }
  }

  /**
   * Get the derived session key.
   * Only valid after successful verifyProof.
   *
   * @returns Raw session key bytes, or null if not authenticated
   */
  getSessionKey(): Uint8Array | null {
    return this.sessionKey;
  }

  /**
   * Check if authentication is complete.
   */
  isAuthenticated(): boolean {
    return this.sessionKey !== null;
  }
}
