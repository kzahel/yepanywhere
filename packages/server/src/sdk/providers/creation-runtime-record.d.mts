import type {
  CreationRuntimeIdentity,
  CreationRuntimeEvidence,
} from "./creation-runtime-identity.js";

export function parseCreationRuntimeIdentity(
  value: unknown,
): CreationRuntimeIdentity;
export function sameCreationRuntimeIdentity(
  expected: CreationRuntimeIdentity,
  received: unknown,
): boolean;
export function parseCreationRuntimeEvidence(
  value: unknown,
): CreationRuntimeEvidence;
