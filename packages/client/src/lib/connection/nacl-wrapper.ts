/**
 * NaCl secretbox encryption helpers for relay protocol (browser-compatible).
 *
 * Uses TweetNaCl for XSalsa20-Poly1305 authenticated encryption.
 */
import nacl from "tweetnacl";

/** Nonce length for secretbox (24 bytes) */
export const NONCE_LENGTH = nacl.secretbox.nonceLength;

/** Key length for secretbox (32 bytes) */
export const KEY_LENGTH = nacl.secretbox.keyLength;

/** Generate a random 24-byte nonce */
export function generateNonce(): Uint8Array {
  return nacl.randomBytes(NONCE_LENGTH);
}

/**
 * Convert Uint8Array to base64 string (browser-compatible).
 */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array (browser-compatible).
 */
function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encrypt a plaintext message with NaCl secretbox.
 * @param plaintext - The message to encrypt (UTF-8 string)
 * @param key - The 32-byte secret key
 * @returns Object with base64-encoded nonce and ciphertext
 */
export function encrypt(
  plaintext: string,
  key: Uint8Array,
): { nonce: string; ciphertext: string } {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  const nonce = generateNonce();
  const message = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.secretbox(message, nonce, key);
  return {
    nonce: uint8ToBase64(nonce),
    ciphertext: uint8ToBase64(ciphertext),
  };
}

/**
 * Decrypt a message encrypted with NaCl secretbox.
 * @param nonce - Base64-encoded nonce
 * @param ciphertext - Base64-encoded ciphertext
 * @param key - The 32-byte secret key
 * @returns Decrypted plaintext string, or null if decryption failed
 */
export function decrypt(
  nonce: string,
  ciphertext: string,
  key: Uint8Array,
): string | null {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  try {
    const nonceBytes = base64ToUint8(nonce);
    const ciphertextBytes = base64ToUint8(ciphertext);

    if (nonceBytes.length !== NONCE_LENGTH) {
      return null;
    }

    const plaintext = nacl.secretbox.open(ciphertextBytes, nonceBytes, key);
    if (!plaintext) {
      return null;
    }
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Derive a 32-byte secretbox key from an SRP session key.
 *
 * SRP produces a large session key (typically 256+ bytes). We hash it
 * with SHA-512 and take the first 32 bytes for use with secretbox.
 *
 * @param srpSessionKey - The raw session key from SRP
 * @returns 32-byte key suitable for secretbox
 */
export function deriveSecretboxKey(srpSessionKey: Uint8Array): Uint8Array {
  return nacl.hash(srpSessionKey).slice(0, KEY_LENGTH);
}

/**
 * Generate a random 32-byte key for testing.
 */
export function generateRandomKey(): Uint8Array {
  return nacl.randomBytes(KEY_LENGTH);
}
