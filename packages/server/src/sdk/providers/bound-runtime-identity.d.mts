import type { NativeSessionRef, YaSessionId } from "@yep-anywhere/shared";

export interface BoundRuntimeIdentity {
  readonly version: 1;
  readonly sessionId: YaSessionId;
  readonly native: NativeSessionRef;
}

export const BOUND_RUNTIME_FEATURE: "session-native-binding-v1";
export const BOUND_RUNTIME_PROTOCOL_VERSION: 3;
export function parseBoundRuntimeIdentity(value: unknown): BoundRuntimeIdentity;
export function sameBoundRuntimeIdentity(
  expected: BoundRuntimeIdentity,
  received: unknown,
): boolean;
