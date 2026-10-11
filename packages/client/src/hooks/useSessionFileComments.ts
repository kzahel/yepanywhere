import { subscribeDraftStorage } from "../lib/draftSyncStorage";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SendSessionViewerComment } from "../contexts/SessionViewerCommentContext";
import {
  formatSessionFileComment,
  formatSessionFileCommentBatch,
  loadSessionFileCommentDrafts,
  saveSessionFileCommentDrafts,
  type SessionFileCommentAnchor,
  type SessionFileCommentDraft,
} from "../lib/sessionFileComments";
import { generateUUID } from "../lib/uuid";

function removeUnchangedSubmittedDrafts(
  current: readonly SessionFileCommentDraft[],
  submitted: readonly SessionFileCommentDraft[],
): SessionFileCommentDraft[] {
  const submittedTextById = new Map(
    submitted.map((draft) => [draft.id, draft.text]),
  );
  return current.filter(
    (draft) => submittedTextById.get(draft.id) !== draft.text,
  );
}

export function useSessionFileComments({
  active,
  storageKey,
  sendComment,
}: {
  active: boolean;
  storageKey: string | null;
  sendComment: SendSessionViewerComment | null;
}) {
  const [drafts, setDrafts] = useState<SessionFileCommentDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState(false);
  const draftsRef = useRef(drafts);
  const activeDraftIdRef = useRef(activeDraftId);
  const sendingIdsRef = useRef(sendingIds);
  const sendCommentRef = useRef(sendComment);
  const storageKeyRef = useRef(storageKey);
  activeDraftIdRef.current = activeDraftId;
  sendingIdsRef.current = sendingIds;
  sendCommentRef.current = sendComment;
  storageKeyRef.current = storageKey;

  useEffect(() => {
    const restored = storageKey ? loadSessionFileCommentDrafts(storageKey) : [];
    draftsRef.current = restored;
    activeDraftIdRef.current = restored.at(-1)?.id ?? null;
    setDrafts(restored);
    setActiveDraftId(activeDraftIdRef.current);
    const idle = new Set<string>();
    sendingIdsRef.current = idle;
    setSendingIds(idle);
    setError(false);
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    return subscribeDraftStorage(storageKey, () => {
      const next = loadSessionFileCommentDrafts(storageKey);
      draftsRef.current = next;
      setDrafts(next);
    });
  }, [storageKey]);

  const persist = useCallback(() => {
    const key = storageKeyRef.current;
    if (key) saveSessionFileCommentDrafts(key, draftsRef.current);
    setDrafts(draftsRef.current);
  }, []);

  const replaceDrafts = useCallback((next: SessionFileCommentDraft[]) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const selectDraft = useCallback((id: string | null) => {
    activeDraftIdRef.current = id;
    setActiveDraftId(id);
  }, []);

  const open = useCallback(
    (anchor: SessionFileCommentAnchor) => {
      setError(false);
      const activeDraft = draftsRef.current.find(
        (draft) => draft.id === activeDraftIdRef.current,
      );
      if (
        activeDraft?.location === anchor.location &&
        activeDraft.quote === anchor.quote
      ) {
        return;
      }
      const retained = draftsRef.current.filter(
        (draft) => draft.id !== activeDraftIdRef.current || draft.text.trim(),
      );
      const existing = retained.find(
        (draft) =>
          draft.location === anchor.location && draft.quote === anchor.quote,
      );
      if (existing) {
        replaceDrafts(retained);
        selectDraft(existing.id);
        return;
      }
      const draft: SessionFileCommentDraft = {
        ...anchor,
        id: generateUUID(),
        text: "",
      };
      replaceDrafts([...retained, draft]);
      selectDraft(draft.id);
    },
    [replaceDrafts, selectDraft],
  );

  const update = useCallback((id: string, text: string) => {
    setError(false);
    draftsRef.current = draftsRef.current.map((draft) =>
      draft.id === id ? { ...draft, text } : draft,
    );
  }, []);

  const cancel = useCallback(
    (id: string) => {
      setError(false);
      replaceDrafts(draftsRef.current.filter((draft) => draft.id !== id));
      if (activeDraftIdRef.current === id) selectDraft(null);
    },
    [replaceDrafts, selectDraft],
  );

  const sendOne = useCallback(
    async (id: string): Promise<boolean> => {
      const draft = draftsRef.current.find((candidate) => candidate.id === id);
      const send = sendCommentRef.current;
      if (!draft?.text.trim() || !send || sendingIdsRef.current.has(id)) {
        return false;
      }
      const nextSending = new Set(sendingIdsRef.current).add(id);
      sendingIdsRef.current = nextSending;
      setSendingIds(nextSending);
      persist();
      const sent = await send(formatSessionFileComment(draft));
      const afterSending = new Set(sendingIdsRef.current);
      afterSending.delete(id);
      sendingIdsRef.current = afterSending;
      setSendingIds(afterSending);
      if (!sent) {
        setError(true);
        return false;
      }
      const remaining = removeUnchangedSubmittedDrafts(draftsRef.current, [
        draft,
      ]);
      replaceDrafts(remaining);
      if (
        activeDraftIdRef.current === id &&
        !remaining.some((item) => item.id === id)
      ) {
        selectDraft(null);
      }
      const key = storageKeyRef.current;
      if (key) saveSessionFileCommentDrafts(key, remaining);
      setError(false);
      return true;
    },
    [persist, replaceDrafts, selectDraft],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    const send = sendCommentRef.current;
    const pending = draftsRef.current.filter(
      (draft) => draft.text.trim() && !sendingIdsRef.current.has(draft.id),
    );
    if (pending.length === 0) {
      persist();
      return true;
    }
    if (!send) {
      persist();
      return false;
    }
    const ids = new Set(pending.map((draft) => draft.id));
    const nextSending = new Set([...sendingIdsRef.current, ...ids]);
    sendingIdsRef.current = nextSending;
    setSendingIds(nextSending);
    persist();
    const sent = await send(formatSessionFileCommentBatch(pending));
    const afterSending = new Set(sendingIdsRef.current);
    for (const id of ids) afterSending.delete(id);
    sendingIdsRef.current = afterSending;
    setSendingIds(afterSending);
    if (!sent) {
      setError(true);
      return false;
    }
    const remaining = removeUnchangedSubmittedDrafts(
      draftsRef.current,
      pending,
    );
    replaceDrafts(remaining);
    if (
      activeDraftIdRef.current &&
      ids.has(activeDraftIdRef.current) &&
      !remaining.some((draft) => draft.id === activeDraftIdRef.current)
    ) {
      selectDraft(null);
    }
    const key = storageKeyRef.current;
    if (key) saveSessionFileCommentDrafts(key, remaining);
    setError(false);
    return true;
  }, [persist, replaceDrafts, selectDraft]);

  useEffect(() => {
    if (!active) return;
    return () => {
      void flush();
    };
  }, [active, flush]);

  return {
    activeDraft: drafts.find((draft) => draft.id === activeDraftId) ?? null,
    cancel,
    error,
    flush,
    open,
    persist,
    sendOne,
    sendingIds,
    update,
  };
}
