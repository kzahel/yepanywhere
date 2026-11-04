import {
  draftStorage,
  subscribeDraftStorage,
  confirmSyncedDraft,
  confirmCapturedDraftSubmission,
  cancelCapturedDraftSubmission,
  resumeSyncedDraft,
} from "../lib/draftSyncStorage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientSummarySourceKey } from "../lib/clientSummaryStore";
import {
  type DraftAttachmentState,
  type DraftEnvelopeV1,
  draftStorageValueForAttachments,
  draftStorageValueForPendingSend,
  draftStorageValueForText,
  hasDraftContentValue,
  hasDraftEnvelopeContent,
  readDraftAttachmentStateValue,
  readDraftEnvelopeValue,
  readDraftPendingSendValue,
  readDraftTextValue,
} from "../lib/draftEnvelope";
import { publishDraftPresenceChange } from "../lib/draftPresenceEvents";
import { getServerClockTimestamp } from "../lib/serverClock";
import {
  createSessionDraftStorageKey,
  markSessionDraftPendingSend,
  removeSessionDraft,
  saveSessionDraft,
  saveSessionDraftAttachmentState,
  updateSessionDraftIndex,
} from "../lib/sessionDraftStorage";

export interface DraftControls {
  /** Return the current in-memory draft value */
  getDraft: () => string;
  /** Read the current staged attachment state from localStorage. */
  getAttachmentState: () => DraftAttachmentState | null;
  /** Replace input state and localStorage immediately */
  setDraft: (value: string) => void;
  /** Replace staged attachment state in the draft envelope. */
  setAttachmentState: (value: DraftAttachmentState | null) => void;
  /** Replace one draft range through the owning textarea when available. */
  replaceDraftRangeUndoably?: (
    start: number,
    end: number,
    replacement: string,
  ) => string | null;
  /** Flush any pending draft write immediately */
  flushDraft: () => void;
  /** Clear input state only, keeping localStorage for failure recovery */
  clearInput: () => void;
  /** Confirm an optimistic clear without deleting a newer live draft. */
  confirmInputClear: () => void;
  /**
   * Discard an untouched post-submit recovery copy once `isAccountedFor`
   * proves the session holds that text from this send or later. Returns true
   * if it discarded.
   */
  discardPendingSendDraft: (
    isAccountedFor: (recovery: PendingSendRecovery) => boolean,
  ) => boolean;
  /** Clear both input state and localStorage (call on confirmed success) */
  clearDraft: () => void;
  /** Capture this exact slot/value before asynchronous creation work. */
  captureSubmission?: () => {
    text: string;
    draftText?: string;
    confirm: () => boolean;
    /** Release this capture without restoring over newer input or storage. */
    cancel: () => void;
  };
  /** Restore from localStorage (call on failure) */
  restoreFromStorage: () => void;
  /** Focus the textarea that owns this draft, if it is mounted. */
  focus?: (options?: FocusOptions) => void;
  /** True while that textarea holds the keyboard. */
  isFocused?: () => boolean;
  /** Place the textarea caret/selection, if it is mounted. */
  setSelectionRange?: (start: number, end: number) => void;
}

/** A post-submit recovery copy and the server-clock time of its submit. */
export interface PendingSendRecovery {
  text: string;
  sentAtMs: number;
}

export interface UseDraftPersistenceOptions {
  /** Keep the current in-memory draft when switching to a new storage key that has no draft yet. */
  preserveValueOnKeyChange?: boolean;
  /** Source-scoped session draft metadata for efficient badge indexing. */
  sessionDraft?: {
    sourceKey: ClientSummarySourceKey;
    sessionId: string;
  };
}

/** Save a value to localStorage immediately */
function saveToStorage(
  key: string,
  value: string,
  sessionDraft?: UseDraftPersistenceOptions["sessionDraft"],
): void {
  if (sessionDraft) {
    saveSessionDraft(sessionDraft, value);
    return;
  }

  try {
    const previousValue = draftStorage.getItem(key);
    const nextValue = draftStorageValueForText(value, previousValue);
    if (nextValue) {
      draftStorage.setItem(key, nextValue);
    } else {
      draftStorage.removeItem(key);
    }
    const previousHasContent = hasDraftContentValue(previousValue);
    const nextHasContent = hasDraftContentValue(nextValue);
    if (previousHasContent !== nextHasContent) {
      publishDraftPresenceChange({
        storageKey: key,
        hasContent: nextHasContent,
      });
    }
  } catch {
    // localStorage might be full or unavailable
  }
}

function saveAttachmentStateToStorage(
  key: string,
  value: DraftAttachmentState | null,
  sessionDraft?: UseDraftPersistenceOptions["sessionDraft"],
): void {
  if (sessionDraft) {
    saveSessionDraftAttachmentState(sessionDraft, value);
    return;
  }

  try {
    const previousValue = draftStorage.getItem(key);
    const nextValue = draftStorageValueForAttachments(value, previousValue);
    // As in `persistSessionDraftEnvelope`: an unchanged value is no edit.
    if (nextValue === previousValue) return;
    if (nextValue) {
      draftStorage.setItem(key, nextValue);
    } else {
      draftStorage.removeItem(key);
    }
    const previousHasContent = hasDraftContentValue(previousValue);
    const nextHasContent = hasDraftContentValue(nextValue);
    if (previousHasContent !== nextHasContent) {
      publishDraftPresenceChange({
        storageKey: key,
        hasContent: nextHasContent,
      });
    }
  } catch {
    // localStorage might be full or unavailable.
  }
}

/**
 * Mark the stored text as a post-submit recovery copy. Content is unchanged,
 * so draft presence does not change and no presence event is published.
 */
function markPendingSendInStorage(
  key: string,
  sentAtMs: number,
  sessionDraft?: UseDraftPersistenceOptions["sessionDraft"],
): void {
  if (sessionDraft) {
    markSessionDraftPendingSend(sessionDraft, sentAtMs);
    return;
  }

  try {
    const nextValue = draftStorageValueForPendingSend(
      draftStorage.getItem(key),
      sentAtMs,
    );
    if (nextValue) {
      draftStorage.setItem(key, nextValue);
    }
  } catch {
    // localStorage might be full or unavailable.
  }
}

function removeFromStorage(
  key: string,
  sessionDraft?: UseDraftPersistenceOptions["sessionDraft"],
): void {
  if (sessionDraft) {
    removeSessionDraft(sessionDraft);
    return;
  }

  try {
    const previousValue = draftStorage.getItem(key);
    draftStorage.removeItem(key);
    if (hasDraftContentValue(previousValue)) {
      publishDraftPresenceChange({
        storageKey: key,
        hasContent: false,
      });
    }
  } catch {
    // localStorage might be unavailable.
  }
}

function readStorageText(key: string): string {
  try {
    return readDraftTextValue(draftStorage.getItem(key));
  } catch {
    return "";
  }
}

function readStoragePendingSend(key: string): boolean {
  try {
    return readDraftPendingSendValue(draftStorage.getItem(key));
  } catch {
    return false;
  }
}

/** One read and one parse for callers that need more than a single field. */
function readStorageDraft(key: string): DraftEnvelopeV1 | null {
  try {
    return readDraftEnvelopeValue(draftStorage.getItem(key)).envelope;
  } catch {
    return null;
  }
}

function readStorageAttachmentState(key: string): DraftAttachmentState | null {
  try {
    return readDraftAttachmentStateValue(draftStorage.getItem(key));
  } catch {
    return null;
  }
}

function updateStoredSessionDraftIndex(
  sessionDraft: UseDraftPersistenceOptions["sessionDraft"],
): void {
  if (!sessionDraft) return;
  try {
    updateSessionDraftIndex(
      sessionDraft,
      draftStorage.getItem(createSessionDraftStorageKey(sessionDraft)),
    );
  } catch {
    updateSessionDraftIndex(sessionDraft, "");
  }
}

/**
 * Hook for persisting draft text to localStorage.
 * Supports failure recovery by keeping localStorage until explicitly cleared.
 *
 * @param key - localStorage key for this draft (e.g., "draft-message-{sessionId}")
 * @returns [value, setValue, controls] - state-like tuple with control functions
 */
export function useDraftPersistence(
  key: string,
  options?: UseDraftPersistenceOptions,
): [string, (value: string) => void, DraftControls] {
  const [value, setValueInternal] = useState(() => readStorageText(key));
  const preserveValueOnKeyChange = options?.preserveValueOnKeyChange ?? false;
  const sessionDraftSourceKey = options?.sessionDraft?.sourceKey;
  const sessionDraftSessionId = options?.sessionDraft?.sessionId;
  const sessionDraft = useMemo(
    () =>
      sessionDraftSourceKey !== undefined && sessionDraftSessionId !== undefined
        ? {
            sourceKey: sessionDraftSourceKey,
            sessionId: sessionDraftSessionId,
          }
        : undefined,
    [sessionDraftSessionId, sessionDraftSourceKey],
  );

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  const sessionDraftRef = useRef(sessionDraft);
  // Track pending value so we can flush on unmount/beforeunload
  const pendingValueRef = useRef<string | null>(null);
  const valueRef = useRef(value);
  // False while the composer still holds exactly what hydration put there.
  // `discardPendingSendDraft` refuses to touch anything the user has since
  // typed, recalled, or otherwise chosen to keep.
  const composerEditedSinceHydrationRef = useRef(false);
  // Mirrors whether storage for the current key holds a post-submit recovery
  // copy. The session reconciles against every transcript update, so that
  // check runs once per streamed chunk and must not parse localStorage.
  const pendingSendRef = useRef(false);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Update keyRef when key changes
  useEffect(() => {
    const previousKey = keyRef.current;
    const previousSessionDraft = sessionDraftRef.current;
    const previousValue = pendingValueRef.current ?? valueRef.current;
    const keyChanged = previousKey !== key;
    const sessionDraftChanged =
      previousSessionDraft?.sourceKey !== sessionDraft?.sourceKey ||
      previousSessionDraft?.sessionId !== sessionDraft?.sessionId;

    if (
      (keyChanged || sessionDraftChanged) &&
      pendingValueRef.current !== null
    ) {
      saveToStorage(previousKey, pendingValueRef.current, previousSessionDraft);
      pendingValueRef.current = null;
    }
    if (sessionDraftChanged && previousSessionDraft) {
      updateStoredSessionDraftIndex(previousSessionDraft);
    }

    // A ref/layout handoff can edit before this first passive effect. An
    // all-whitespace edit is intentionally absent from durable storage, so
    // reading it back would erase the first typed space. A new draft identity
    // still hydrates normally; the initial identity was loaded by useState.
    if (
      !keyChanged &&
      !sessionDraftChanged &&
      composerEditedSinceHydrationRef.current
    )
      return;
    keyRef.current = key;
    sessionDraftRef.current = sessionDraft;
    composerEditedSinceHydrationRef.current = false;

    try {
      const stored = readStorageDraft(key);
      if (
        (keyChanged || sessionDraftChanged) &&
        preserveValueOnKeyChange &&
        previousValue &&
        !hasDraftEnvelopeContent(stored)
      ) {
        saveToStorage(key, previousValue, sessionDraft);
        valueRef.current = previousValue;
        // Carried-over text is the user's, not a hydrated recovery copy.
        composerEditedSinceHydrationRef.current = true;
        pendingSendRef.current = false;
        setValueInternal(previousValue);
        return;
      }
      const storedText = stored?.text ?? "";
      pendingSendRef.current = stored?.pendingSendAt !== undefined;
      valueRef.current = storedText;
      setValueInternal(storedText);
    } catch {
      pendingSendRef.current = false;
      valueRef.current = "";
      setValueInternal("");
    }
  }, [key, preserveValueOnKeyChange, sessionDraft]);

  useEffect(
    () =>
      subscribeDraftStorage(key, () => {
        const stored = readStorageDraft(key);
        valueRef.current = stored?.text ?? "";
        pendingSendRef.current = stored?.pendingSendAt !== undefined;
        setValueInternal(valueRef.current);
        updateStoredSessionDraftIndex(sessionDraftRef.current);
      }),
    [key],
  );

  // Flush pending value to localStorage
  const flushPending = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (pendingValueRef.current !== null) {
      saveToStorage(
        keyRef.current,
        pendingValueRef.current,
        sessionDraftRef.current,
      );
      // A text write drops the recovery marker.
      pendingSendRef.current = false;
      pendingValueRef.current = null;
    }
  }, []);

  // Handle lifecycle boundaries to save drafts before the page can be frozen,
  // discarded, or refreshed. `pagehide` covers mobile/browser cache paths where
  // `beforeunload` is skipped.
  useEffect(() => {
    const handlePageExit = () => {
      flushPending();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPending();
      }
    };
    window.addEventListener("beforeunload", handlePageExit);
    window.addEventListener("pagehide", handlePageExit);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handlePageExit);
      window.removeEventListener("pagehide", handlePageExit);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushPending]);

  // A second tab on the same session writes the same storage key. Its submit
  // is what marks the shared copy as a recovery copy, and a `storage` event is
  // the only notice this document gets, so the cached verdict is refreshed
  // here instead of being re-read on every reconcile. A null key is a whole
  // storage clear.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null) {
        pendingSendRef.current = false;
        return;
      }
      if (event.key !== keyRef.current) return;
      pendingSendRef.current = readDraftPendingSendValue(event.newValue);
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // Save each edit immediately. A debounce window can lose the newest typed
  // text during HMR/reload paths that do not reliably fire page lifecycle
  // events before React remounts and restores the previous storage value.
  const setValue = useCallback((newValue: string) => {
    valueRef.current = newValue;
    composerEditedSinceHydrationRef.current = true;
    pendingSendRef.current = false;
    setValueInternal(newValue);
    pendingValueRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    saveToStorage(keyRef.current, newValue, sessionDraftRef.current);
  }, []);

  // Read the current in-memory value for UI actions that append to the draft.
  const getDraft = useCallback(() => valueRef.current, []);

  const getAttachmentState = useCallback(
    () => readStorageAttachmentState(keyRef.current),
    [],
  );

  // Replace the draft immediately. This is used when another UI action, such
  // as editing a queued message, needs to take over the composer.
  const setDraft = useCallback((newValue: string) => {
    valueRef.current = newValue;
    composerEditedSinceHydrationRef.current = true;
    pendingSendRef.current = false;
    setValueInternal(newValue);
    pendingValueRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    saveToStorage(keyRef.current, newValue, sessionDraftRef.current);
  }, []);

  const setAttachmentState = useCallback(
    (newValue: DraftAttachmentState | null) => {
      saveAttachmentStateToStorage(
        keyRef.current,
        newValue,
        sessionDraftRef.current,
      );
    },
    [],
  );

  // Clear input state only (for optimistic UI on submit)
  const clearInput = useCallback(() => {
    if (pendingValueRef.current !== null) {
      saveToStorage(
        keyRef.current,
        pendingValueRef.current,
        sessionDraftRef.current,
      );
    }
    valueRef.current = "";
    composerEditedSinceHydrationRef.current = false;
    setValueInternal("");
    pendingValueRef.current = null;
    // Cancel pending write so we don't overwrite the recovery draft with ""
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    // Label the surviving copy as post-submit recovery text, dated on the
    // server's clock so transcript and queue timestamps compare with it. It
    // stays visible to a reload or a sibling tab, but becomes eligible for
    // discard once the session proves this send, not an earlier identical one,
    // actually landed.
    markPendingSendInStorage(
      keyRef.current,
      getServerClockTimestamp(),
      sessionDraftRef.current,
    );
    // An empty composer leaves nothing to mark, so ask storage rather than
    // assuming the marker landed.
    pendingSendRef.current = readStoragePendingSend(keyRef.current);
  }, []);

  /**
   * Drop a post-submit recovery copy the session has accounted for. Applies
   * only to storage this hook marked `pendingSend` and only while the composer
   * still holds exactly that copy (a sibling tab) or nothing at all (the
   * submitting tab). Returns true when a draft was discarded.
   */
  const discardPendingSendDraft = useCallback(
    (isAccountedFor: (recovery: PendingSendRecovery) => boolean): boolean => {
      if (composerEditedSinceHydrationRef.current) return false;
      if (!pendingSendRef.current) return false;
      const key = keyRef.current;
      const stored = readStorageDraft(key);
      if (stored?.pendingSendAt === undefined) {
        pendingSendRef.current = false;
        return false;
      }
      const storedText = stored.text;
      if (!storedText.trim()) return false;
      if (valueRef.current !== "" && valueRef.current !== storedText) {
        return false;
      }
      if (
        !isAccountedFor({ text: storedText, sentAtMs: stored.pendingSendAt })
      ) {
        return false;
      }

      valueRef.current = "";
      setValueInternal("");
      pendingValueRef.current = null;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      confirmSyncedDraft(key);
      removeFromStorage(key, sessionDraftRef.current);
      pendingSendRef.current = false;
      return true;
    },
    [],
  );

  // A successful async submission may settle after the user has already
  // started the next turn. Remove the recovery copy only while the optimistic
  // clear still owns an empty live input; otherwise localStorage now contains
  // the newer draft and must remain untouched.
  const confirmInputClear = useCallback(() => {
    confirmSyncedDraft(keyRef.current);
    if (valueRef.current !== "") return;
    removeFromStorage(keyRef.current, sessionDraftRef.current);
    pendingSendRef.current = false;
  }, []);

  const captureSubmission = useCallback(() => {
    const capturedKey = keyRef.current;
    const capturedSession = sessionDraftRef.current;
    const capturedText = valueRef.current;
    if (pendingValueRef.current !== null) {
      saveToStorage(capturedKey, pendingValueRef.current, capturedSession);
      pendingValueRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const physicalKey = draftStorage.physicalKey(capturedKey);
    const before = draftStorage.getItem(capturedKey);
    // A queued sibling event may already have changed physical storage.
    if (localStorage.getItem(physicalKey) === before)
      markPendingSendInStorage(
        capturedKey,
        getServerClockTimestamp(),
        capturedSession,
      );
    const capturedValue = draftStorage.getItem(capturedKey);
    return {
      text: capturedText,
      draftText: readDraftPendingSendValue(capturedValue)
        ? readDraftTextValue(capturedValue)
        : capturedText,
      confirm() {
        const ownsInput =
          keyRef.current === capturedKey && valueRef.current === capturedText;
        if (
          !confirmCapturedDraftSubmission({
            key: capturedKey,
            physicalKey,
            raw: capturedValue,
          })
        )
          return false;
        updateStoredSessionDraftIndex(capturedSession);
        if (!capturedSession && hasDraftContentValue(capturedValue))
          publishDraftPresenceChange({
            storageKey: capturedKey,
            hasContent: false,
          });
        if (!ownsInput) return false;
        valueRef.current = "";
        pendingSendRef.current = false;
        setValueInternal("");
        return true;
      },
      cancel() {
        cancelCapturedDraftSubmission({
          key: capturedKey,
          physicalKey,
          raw: capturedValue,
        });
      },
    };
  }, []);

  // Clear both state and localStorage (for confirmed successful send)
  const clearDraft = useCallback(() => {
    confirmSyncedDraft(keyRef.current);
    valueRef.current = "";
    pendingSendRef.current = false;
    setValueInternal("");
    pendingValueRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    removeFromStorage(keyRef.current, sessionDraftRef.current);
  }, []);

  // Restore from localStorage (for failure recovery)
  const restoreFromStorage = useCallback(() => {
    resumeSyncedDraft(keyRef.current);
    try {
      const storedText = readStorageText(keyRef.current);
      valueRef.current = storedText;
      // A failed response can precede proof of delivery. Restoring the
      // recovery copy is not a user edit; keep it eligible for reconciliation.
      // Actual edits since the optimistic clear keep their protection.
      setValueInternal(storedText);
    } catch {
      // Ignore errors
    }
  }, []);

  // Flush pending and cleanup on unmount
  useEffect(() => {
    return () => {
      // Flush any pending value before unmount (handles HMR and navigation)
      if (pendingValueRef.current !== null) {
        saveToStorage(
          keyRef.current,
          pendingValueRef.current,
          sessionDraftRef.current,
        );
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const controls = useMemo(
    () => ({
      getDraft,
      getAttachmentState,
      setDraft,
      setAttachmentState,
      flushDraft: flushPending,
      clearInput,
      confirmInputClear,
      discardPendingSendDraft,
      clearDraft,
      captureSubmission,
      restoreFromStorage,
    }),
    [
      getDraft,
      getAttachmentState,
      setDraft,
      setAttachmentState,
      flushPending,
      clearInput,
      confirmInputClear,
      discardPendingSendDraft,
      clearDraft,
      captureSubmission,
      restoreFromStorage,
    ],
  );

  return [value, setValue, controls];
}
