// SRP authentication types
export type {
  SrpClientHello,
  SrpServerChallenge,
  SrpClientProof,
  SrpServerVerify,
  SrpError,
  SrpErrorCode,
  SrpClientMessage,
  SrpServerMessage,
  SrpMessage,
} from "./srp-types.js";

export {
  isSrpClientHello,
  isSrpClientProof,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpError,
} from "./srp-types.js";

// Encryption types
export type { EncryptedEnvelope } from "./encryption-types.js";
export { isEncryptedEnvelope } from "./encryption-types.js";
