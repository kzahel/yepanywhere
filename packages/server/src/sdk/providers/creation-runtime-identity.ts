import type { NativeSessionRef, YaSessionId } from "@yep-anywhere/shared";
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

// Plain ESM keeps the headless host and TS worker on the same private decoder.
export {
  parseCreationRuntimeIdentity,
  parseCreationRuntimeEvidence,
  sameCreationRuntimeIdentity,
} from "./creation-runtime-record.mjs";

/** Native confirmation only: SDK queue pulls and failed-send echoes do not qualify. */
export function observeProviderInputIds(
  message: SDKMessage,
  claudeResponseStamps: boolean,
  observe: (id: string) => void,
): void {
  if (
    claudeResponseStamps &&
    message.type === "user" &&
    typeof message.uuid === "string"
  )
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
