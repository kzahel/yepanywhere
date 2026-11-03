import {
  nativeSessionRef,
  type NativeSessionRef,
  type YaSessionId,
  type NativeSessionId,
} from "@yep-anywhere/shared";
import type { ManagedProcessIdentity } from "../supervisor/Process.js";
import type {
  SessionIdentityStore,
  NativeSessionNamespace,
} from "./SessionIdentityStore.js";
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
  let boundNativeId: NativeSessionId | undefined;
  return {
    sessionId: saved.sessionId,
    bindNative(id) {
      store.bindNative(
        fence,
        nativeSessionRef(namespace.family, namespace.storageScope, id),
      );
      boundNativeId = id;
    },
    assertInputAdmission() {
      const current = store.assertCurrent(fence);
      if (!["dispatching", "bound"].includes(current.attempt.state)) {
        throw new StaleCreationAttempt();
      }
    },
    observeProviderInput(uuid) {
      if (consumed || uuid !== saved.initialInputId) return;
      if (!boundNativeId)
        throw new Error("Provider input confirmation lacks native binding");
      if (store.assertCurrent(fence).attempt.delivery !== "consumed")
        store.confirmOwnedInput(
          fence,
          nativeSessionRef(
            namespace.family,
            namespace.storageScope,
            boundNativeId,
          ),
          uuid,
        );
      consumed = true;
    },
    ownerExited() {
      try {
        const current = store.assertCurrent(fence);
        if (
          current.attempt.delivery !== "consumed" &&
          !(
            Boolean(current.request?.intent) &&
            current.attempt.state === "bound"
          ) &&
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

/** A cold continuation validates its existing address; it never rebinds it. */
export function boundProcessIdentity(
  identities: SessionIdentityStore,
  sessionId: YaSessionId,
  native: NativeSessionRef,
  assertAdmission: () => void,
): ManagedProcessIdentity {
  const assertCurrent = () => {
    const current = identities.resolveYa(sessionId)?.native;
    if (
      !current ||
      current.family !== native.family ||
      current.storageScope !== native.storageScope ||
      current.id !== native.id
    )
      throw new Error("Session native binding changed before continuation");
    assertAdmission();
  };
  return {
    sessionId,
    bindNative(id) {
      assertCurrent();
      if (id !== native.id)
        throw new Error("Provider resumed a different native session");
    },
    assertInputAdmission: assertCurrent,
    observeProviderInput() {},
  };
}
