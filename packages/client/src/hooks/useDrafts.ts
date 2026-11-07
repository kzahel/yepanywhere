import {
  draftStorage,
  subscribeDraftStorage,
  confirmSyncedDraft,
} from "../lib/draftSyncStorage";
import { useCallback, useEffect, useState } from "react";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
  useDraftSessionIds,
} from "../lib/clientSummaryStore";
import { hasDraftContentValue, readDraftTextValue } from "../lib/draftEnvelope";
import { subscribeDraftPresenceChanges } from "../lib/draftPresenceEvents";

const NEW_SESSION_DRAFT_KEY_PREFIX = "draft-new-session:";

function encodeDraftKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function createNewSessionDraftKey(
  sourceKey: ClientSummarySourceKey,
  projectId?: string,
): string {
  const base = `${NEW_SESSION_DRAFT_KEY_PREFIX}${encodeDraftKeyPart(sourceKey)}`;
  return projectId ? `${base}:${encodeDraftKeyPart(projectId)}` : base;
}

/**
 * Returns `prev` if both sets contain the same elements, otherwise `next`.
 * Used to avoid React re-renders when the draft set hasn't actually changed.
 */
export function setsEqual<T>(prev: Set<T>, next: Set<T>): Set<T> {
  if (prev.size !== next.size) return next;
  for (const id of next) {
    if (!prev.has(id)) return next;
  }
  return prev;
}

/**
 * Hook to track which sessions have draft messages in localStorage.
 * Returns session IDs with non-empty drafts.
 *
 * The client summary store owns the initial scan, cross-tab storage listener,
 * and owned same-tab presence-event feed.
 */
export function useDrafts(): ReadonlySet<string> {
  return useDraftSessionIds();
}

/**
 * Hook to track whether the new session form has a draft.
 * Listens for owned same-tab persistence events and cross-tab storage events.
 */
export function useNewSessionDraft(projectId?: string): boolean {
  const sourceKey = useClientSummarySourceKey();
  const [hasDraft, setHasDraft] = useState(() =>
    checkNewSessionDraft(sourceKey, projectId),
  );

  const check = useCallback(() => {
    setHasDraft(checkNewSessionDraft(sourceKey, projectId));
  }, [projectId, sourceKey]);

  // Re-check when projectId changes
  useEffect(() => {
    check();
  }, [check]);

  // Listen for storage events (changes from other tabs)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (getNewSessionDraftKeys(sourceKey, projectId).includes(e.key ?? "")) {
        check();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [check, projectId, sourceKey]);

  useEffect(() => {
    const keys = new Set(getNewSessionDraftKeys(sourceKey, projectId));
    return subscribeDraftPresenceChanges((change) => {
      if (keys.has(change.storageKey)) {
        check();
      }
    });
  }, [check, projectId, sourceKey]);

  return hasDraft;
}

function checkNewSessionDraft(
  sourceKey: ClientSummarySourceKey,
  projectId: string | undefined,
): boolean {
  try {
    return getNewSessionDraftKeys(sourceKey, projectId).some((key) => {
      const value = draftStorage.getItem(key);
      return hasDraftContentValue(value);
    });
  } catch {
    return false;
  }
}

function getNewSessionDraftKeys(
  sourceKey: ClientSummarySourceKey,
  projectId: string | undefined,
): string[] {
  const sharedKey = createNewSessionDraftKey(sourceKey);
  return projectId
    ? [sharedKey, createNewSessionDraftKey(sourceKey, projectId)]
    : [sharedKey];
}

const TOOL_APPROVAL_FEEDBACK_DRAFT_KEY_PREFIX = "draft-tool-approval-feedback:";
const QUESTION_OTHER_DRAFT_KEY_PREFIX = "draft-question-other:";

export function createToolApprovalFeedbackDraftKey(
  sourceKey: ClientSummarySourceKey,
  sessionId: string,
): string {
  return `${TOOL_APPROVAL_FEEDBACK_DRAFT_KEY_PREFIX}${encodeDraftKeyPart(sourceKey)}:${encodeDraftKeyPart(sessionId)}`;
}

export function createQuestionOtherDraftKey(
  sourceKey: ClientSummarySourceKey,
  sessionId: string,
): string {
  return `${QUESTION_OTHER_DRAFT_KEY_PREFIX}${encodeDraftKeyPart(sourceKey)}:${encodeDraftKeyPart(sessionId)}`;
}

function readStringDraft(key: string): string {
  try {
    return readDraftTextValue(draftStorage.getItem(key));
  } catch {
    return "";
  }
}

function readQuestionOtherDrafts(key: string): Record<string, string> {
  try {
    const stored = draftStorage.getItem(key);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Hook to persist draft text for tool approval feedback.
 * Keyed by source and sessionId, not by specific tool call.
 *
 * @param sessionId - The session ID
 * @returns [value, setValue, clearValue] tuple
 */
export function useToolApprovalFeedbackDraft(
  sessionId: string,
): [string, (value: string) => void, () => void] {
  const sourceKey = useClientSummarySourceKey();
  const key = createToolApprovalFeedbackDraftKey(sourceKey, sessionId);

  const [value, setValueState] = useState<string>(() => readStringDraft(key));

  useEffect(() => {
    setValueState(readStringDraft(key));
  }, [key]);

  useEffect(
    () => subscribeDraftStorage(key, () => setValueState(readStringDraft(key))),
    [key],
  );
  const setValue = useCallback(
    (newValue: string) => {
      setValueState(newValue);
      try {
        if (newValue) {
          draftStorage.setItem(key, newValue);
        } else {
          draftStorage.removeItem(key);
        }
      } catch {
        // localStorage might be unavailable
      }
    },
    [key],
  );

  const clearValue = useCallback(() => {
    confirmSyncedDraft(key);
    setValueState("");
    try {
      draftStorage.removeItem(key);
    } catch {
      // localStorage might be unavailable
    }
  }, [key]);

  return [value, setValue, clearValue];
}

/**
 * Hook to persist "Other" text inputs for AskUserQuestion panels.
 * Stores a map of question text -> otherText, keyed by source and sessionId.
 *
 * For multi-stage questions (multiple tabs), each question's "Other"
 * input is stored separately under the same session key. When navigating
 * between tabs, each tab's draft is preserved.
 *
 * @param sessionId - The session ID
 * @returns [otherTexts, setOtherText, clearAll] tuple
 */
export function useQuestionOtherDrafts(
  sessionId: string,
): [
  Record<string, string>,
  (question: string, value: string) => void,
  () => void,
] {
  const sourceKey = useClientSummarySourceKey();
  const key = createQuestionOtherDraftKey(sourceKey, sessionId);

  const [otherTexts, setOtherTextsState] = useState<Record<string, string>>(
    () => readQuestionOtherDrafts(key),
  );

  useEffect(() => {
    setOtherTextsState(readQuestionOtherDrafts(key));
  }, [key]);

  useEffect(
    () =>
      subscribeDraftStorage(key, () =>
        setOtherTextsState(readQuestionOtherDrafts(key)),
      ),
    [key],
  );
  const setOtherText = useCallback(
    (question: string, value: string) => {
      setOtherTextsState((prev) => {
        const next = { ...prev };
        if (value) {
          next[question] = value;
        } else {
          delete next[question];
        }
        try {
          if (Object.keys(next).length > 0) {
            draftStorage.setItem(key, JSON.stringify(next));
          } else {
            draftStorage.removeItem(key);
          }
        } catch {
          // localStorage might be unavailable
        }
        return next;
      });
    },
    [key],
  );

  const clearAll = useCallback(() => {
    confirmSyncedDraft(key);
    setOtherTextsState({});
    try {
      draftStorage.removeItem(key);
    } catch {
      // localStorage might be unavailable
    }
  }, [key]);

  return [otherTexts, setOtherText, clearAll];
}
