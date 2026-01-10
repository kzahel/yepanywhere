/**
 * Encrypted message envelope for relay traffic.
 *
 * All messages after SRP handshake are wrapped in this format.
 * Uses NaCl secretbox (XSalsa20-Poly1305).
 */

/** Encrypted message wrapper */
export interface EncryptedEnvelope {
  type: "encrypted";
  /** Random 24-byte nonce (base64) */
  nonce: string;
  /** Encrypted payload (base64) */
  ciphertext: string;
}

/** Type guard for encrypted envelope */
export function isEncryptedEnvelope(msg: unknown): msg is EncryptedEnvelope {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as EncryptedEnvelope).type === "encrypted" &&
    typeof (msg as EncryptedEnvelope).nonce === "string" &&
    typeof (msg as EncryptedEnvelope).ciphertext === "string"
  );
}
