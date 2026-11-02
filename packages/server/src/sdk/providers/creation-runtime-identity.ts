import {
  NATIVE_SESSION_FAMILIES,
  parseNativeSessionId,
  parseYaSessionId,
  type NativeSessionRef,
  type YaSessionId,
} from "@yep-anywhere/shared";
import { isAbsolute } from "node:path";
import type { SDKMessage } from "../types.js";

/** Private immutable launch identity; authorization remains with the controller. */
export interface CreationRuntimeIdentity {
  readonly version: 1;
  readonly sessionId: YaSessionId;
  readonly creationId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly nativeNamespace: Pick<NativeSessionRef, "family" | "storageScope">;
  /** Absent when the provider allocates its own native id. */
  readonly nativeSessionId?: NativeSessionRef["id"];
  readonly initialInputId: string;
}

export interface CreationRuntimeEvidence {
  readonly identity: CreationRuntimeIdentity;
  readonly nativeSessionId?: NativeSessionRef["id"];
  readonly initialInputConsumed: boolean;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Decode/copy untrusted socket data without retaining unknown fields. */
export function parseCreationRuntimeIdentity(
  value: unknown,
): CreationRuntimeIdentity {
  if (!value || typeof value !== "object")
    throw new Error("Missing creation identity");
  const record = value as Record<string, unknown>;
  const namespace = record.nativeNamespace as
    | Record<string, unknown>
    | undefined;
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.generation) ||
    Number(record.generation) < 1 ||
    !namespace ||
    !NATIVE_SESSION_FAMILIES.includes(
      namespace.family as NativeSessionRef["family"],
    ) ||
    typeof namespace.storageScope !== "string" ||
    namespace.storageScope.length > 4096 ||
    hasControlCharacters(namespace.storageScope) ||
    !isAbsolute(namespace.storageScope)
  )
    throw new Error("Invalid creation identity");
  return Object.freeze({
    version: 1,
    sessionId: parseYaSessionId(record.sessionId),
    creationId: parseYaSessionId(record.creationId),
    attemptId: parseYaSessionId(record.attemptId),
    generation: Number(record.generation),
    nativeNamespace: Object.freeze({
      family: namespace.family as NativeSessionRef["family"],
      storageScope: namespace.storageScope,
    }),
    ...(record.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: parseNativeSessionId(record.nativeSessionId) }),
    initialInputId: parseYaSessionId(record.initialInputId),
  });
}

export function sameCreationRuntimeIdentity(
  expected: CreationRuntimeIdentity,
  received: unknown,
): boolean {
  try {
    return (
      JSON.stringify(parseCreationRuntimeIdentity(expected)) ===
      JSON.stringify(parseCreationRuntimeIdentity(received))
    );
  } catch {
    return false;
  }
}

/** Native confirmation only: SDK queue pulls and failed-send echoes do not qualify. */
export function observeProviderInputIds(
  message: SDKMessage,
  claudeResponseStamps: boolean,
  observe: (id: string) => void,
): void {
  if (message.type === "user" && typeof message.uuid === "string")
    observe(message.uuid);
  if (
    !claudeResponseStamps ||
    message.parent_tool_use_id ||
    !(
      message.type === "assistant" ||
      message.type === "stream_event" ||
      (message.type === "result" && message.subtype === "success")
    )
  )
    return;
  if (typeof message.user_message_uuid === "string")
    observe(message.user_message_uuid);
  if (
    Array.isArray(message.user_message_uuids) &&
    message.user_message_uuids.length <= 64
  ) {
    for (const id of message.user_message_uuids)
      if (typeof id === "string") observe(id);
  }
}
