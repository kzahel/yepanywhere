import { nativeSessionRef } from "@yep-anywhere/shared";
import type { ManagedProcessIdentity } from "../supervisor/Process.js";
import type { NativeSessionNamespace } from "./SessionIdentityStore.js";
import {
  StaleCreationAttempt,
  type CreationAttemptFence,
  type SessionCreationStore,
} from "./SessionCreationStore.js";

/** One launch's control-plane callbacks, with no streaming-event SQL work. */
export function creationProcessIdentity(
  store: SessionCreationStore,
  fence: CreationAttemptFence,
  namespace: NativeSessionNamespace,
): ManagedProcessIdentity {
  const saved = store.assertCurrent(fence);
  if (!saved.initialInputId || !saved.request?.launch) {
    throw new Error("Saved creation lacks dispatchable launch/input identity");
  }
  let consumed = saved.attempt.delivery === "consumed";
  return {
    sessionId: saved.sessionId,
    bindNative(id) {
      store.bindNative(
        fence,
        nativeSessionRef(namespace.family, namespace.storageScope, id),
      );
    },
    assertInputAdmission() {
      const current = store.assertCurrent(fence);
      if (!["dispatching", "bound"].includes(current.attempt.state)) {
        throw new StaleCreationAttempt();
      }
    },
    observeProviderInput(uuid) {
      if (consumed || uuid !== saved.initialInputId) return;
      store.markDelivery(fence, "consumed");
      consumed = true;
    },
    ownerExited() {
      try {
        const current = store.assertCurrent(fence);
        if (
          current.attempt.delivery !== "consumed" &&
          ["dispatching", "bound"].includes(current.attempt.state)
        ) {
          store.markUncertain(fence);
        }
      } catch (error) {
        if (!(error instanceof StaleCreationAttempt)) throw error;
      }
    },
  };
}
