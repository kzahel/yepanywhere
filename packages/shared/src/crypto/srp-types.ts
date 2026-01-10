/**
 * SRP-6a handshake message types for zero-knowledge password authentication.
 *
 * Flow:
 * 1. Client → Server: SrpClientHello (identity)
 * 2. Server → Client: SrpServerChallenge (salt, B)
 * 3. Client → Server: SrpClientProof (A, M1)
 * 4. Server → Client: SrpServerVerify (M2) or SrpError
 */

/** Client initiates SRP handshake with identity */
export interface SrpClientHello {
  type: "srp_hello";
  /** Username/identity */
  identity: string;
}

/** Server responds with salt and ephemeral public value B */
export interface SrpServerChallenge {
  type: "srp_challenge";
  /** Salt used to generate verifier (hex string) */
  salt: string;
  /** Server ephemeral public value (hex string) */
  B: string;
}

/** Client sends ephemeral public value and proof that it knows the password */
export interface SrpClientProof {
  type: "srp_proof";
  /** Client ephemeral public value (hex string) */
  A: string;
  /** Client proof value M1 (hex string) */
  M1: string;
}

/** Server verifies client and proves it knows verifier */
export interface SrpServerVerify {
  type: "srp_verify";
  /** Server proof value M2 (hex string) */
  M2: string;
}

/** SRP error codes */
export type SrpErrorCode =
  | "invalid_identity"
  | "invalid_proof"
  | "server_error";

/** SRP error (authentication failed) */
export interface SrpError {
  type: "srp_error";
  /** Error code */
  code: SrpErrorCode;
  /** Human-readable message */
  message: string;
}

/** All SRP messages from client to server */
export type SrpClientMessage = SrpClientHello | SrpClientProof;

/** All SRP messages from server to client */
export type SrpServerMessage = SrpServerChallenge | SrpServerVerify | SrpError;

/** All SRP protocol messages */
export type SrpMessage = SrpClientMessage | SrpServerMessage;

/** Type guards */
export function isSrpClientHello(msg: unknown): msg is SrpClientHello {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpClientHello).type === "srp_hello"
  );
}

export function isSrpClientProof(msg: unknown): msg is SrpClientProof {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpClientProof).type === "srp_proof"
  );
}

export function isSrpServerChallenge(msg: unknown): msg is SrpServerChallenge {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpServerChallenge).type === "srp_challenge"
  );
}

export function isSrpServerVerify(msg: unknown): msg is SrpServerVerify {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpServerVerify).type === "srp_verify"
  );
}

export function isSrpError(msg: unknown): msg is SrpError {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as SrpError).type === "srp_error"
  );
}
